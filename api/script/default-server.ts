// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as api from "./api";
import { AzureStorage } from "./storage/azure-storage";
import { fileUploadMiddleware } from "./file-upload-manager";
import { JsonStorage } from "./storage/json-storage";
import { createMetricsManager, MetricsManager } from "./metrics-manager";
import { Storage } from "./storage/storage";
import { SupabaseStorage } from "./storage/supabase-storage";
import { Response } from "express";
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

import * as bodyParser from "body-parser";
const domain = require("express-domain-middleware");
import * as express from "express";
import * as q from "q";

interface Secret {
  id: string;
  value: string;
}

// Hostnames a browser can only reach from the machine the process runs on.
const LOOPBACK_HOSTNAME_TEST: RegExp = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

function isLoopbackServerUrl(serverUrl: string): boolean {
  // Unset SERVER_URL is the shape of a developer running `npm start` on a laptop:
  // the OAuth flow needs it, so any deployment that serves developers has it set.
  if (!serverUrl) {
    return true;
  }

  try {
    return LOOPBACK_HOSTNAME_TEST.test(new URL(serverUrl).hostname);
  } catch (error) {
    // Unparseable means "we cannot prove this is local", which resolves to refuse.
    return false;
  }
}

// DEBUG_DISABLE_AUTH USED TO BE A LIE, and that is why this function exists.
//
// `auth.authenticate` was applied unconditionally BELOW the if/else that mounts
// the impersonation middleware, so with the flag on, every management request
// still went through the bearer strategy: the flag wrote `req.user` and the real
// strategy overwrote it a microsecond later, or -- with no Authorization header --
// answered 401 first. Whoever set the flag concluded the SERVER was broken.
// (The mechanism usually blamed, `passport.initialize()` living inside the router
// this branch never mounts, is NOT the cause: passport 0.6's authenticate()
// installs the request extensions itself and short-circuits to the supplied
// callback, so the bearer strategy runs perfectly well without initialize().)
//
// Making the flag honest means making it REAL, and a real auth bypass here hands
// an anonymous caller the ability to push arbitrary JavaScript to every till in
// the fleet. So it is honoured only where it cannot be reached from outside, and
// it REFUSES TO BOOT anywhere else rather than quietly degrading: a container
// that will not start is a bug report; a container that silently serves an open
// management API is an incident.
function isAuthBypassEnabled(): boolean {
  if (process.env.DEBUG_DISABLE_AUTH !== "true") {
    return false;
  }

  if (process.env.NODE_ENV === "production" || !isLoopbackServerUrl(process.env.SERVER_URL)) {
    throw new Error(
      "DEBUG_DISABLE_AUTH=true disables authentication on the CodePush MANAGEMENT API, " +
        "which can release arbitrary JavaScript to every device in the fleet. It is honoured " +
        "only when NODE_ENV is not 'production' and SERVER_URL is unset or loopback. " +
        `Refusing to start (NODE_ENV=${process.env.NODE_ENV || "<unset>"}, ` +
        `SERVER_URL=${process.env.SERVER_URL || "<unset>"}). ` +
        "Unset DEBUG_DISABLE_AUTH and authenticate with an access key instead."
    );
  }

  return true;
}

function bodyParserErrorHandler(err: any, req: express.Request, res: express.Response, next: Function): void {
  if (err) {
    if (err.message === "invalid json" || (err.name === "SyntaxError" && ~err.stack.indexOf("body-parser"))) {
      req.body = null;
      next();
    } else {
      next(err);
    }
  } else {
    next();
  }
}

export function start(done: (err?: any, server?: express.Express, storage?: Storage) => void, useJsonStorage?: boolean): void {
  let storage: Storage;
  let isKeyVaultConfigured: boolean;
  let keyvaultClient: any;

  q<void>(null)
    .then(async () => {
      if (useJsonStorage) {
        storage = new JsonStorage();
      } else if (process.env.CODEPUSH_STORAGE_BACKEND === "supabase") {
        // EXPLICIT opt-in, and deliberately ahead of the Azure branches rather
        // than replacing them. The cutover runs in two flips: FLIP A moves the
        // NETWORK (container on the VPS, App Service demoted to a proxy) while
        // still running THIS process against the existing Azure table and blobs,
        // and only FLIP B swaps the data layer by setting this one variable.
        // Both Azure paths therefore have to keep working untouched, and the
        // revert from FLIP B is un-setting this variable plus a restart.
        storage = new SupabaseStorage();
      } else if (!process.env.AZURE_KEYVAULT_ACCOUNT) {
        storage = new AzureStorage();
      } else {
        isKeyVaultConfigured = true;

        const credential = new DefaultAzureCredential();

        const vaultName = process.env.AZURE_KEYVAULT_ACCOUNT;
        const url = `https://${vaultName}.vault.azure.net`;

        const keyvaultClient = new SecretClient(url, credential);
        const secret = await keyvaultClient.getSecret(`storage-${process.env.AZURE_STORAGE_ACCOUNT}`);
        storage = new AzureStorage(process.env.AZURE_STORAGE_ACCOUNT, secret);
      }
    })
    .then(() => {
      const app = express();
      const auth = api.auth({ storage: storage });
      const appInsights = api.appInsights();
      // Cache + deployment metrics. Which implementation this is depends on
      // CODEPUSH_METRICS_BACKEND and NOTHING else -- unset (the default) is the
      // Azure Redis manager, byte for byte today's behaviour, which is what
      // FLIP A of the cutover runs on. `supabase` selects the in-process cache
      // plus Postgres metrics and drops the Redis instance entirely.
      //
      // Deliberately a SEPARATE switch from CODEPUSH_STORAGE_BACKEND above:
      // being able to move the data layer and the metrics independently is what
      // makes a partial rollback possible. FLIP B sets both.
      //
      // The variable below keeps the name `redisManager` because that is the
      // property name on both router configs; its TYPE is now the interface.
      const redisManager: MetricsManager = createMetricsManager();

      // First, to wrap all requests and catch all exceptions.
      app.use(domain);

      // Monkey-patch res.send and res.setHeader to no-op after the first call and prevent "already sent" errors.
      app.use((req: express.Request, res: express.Response, next: (err?: any) => void): any => {
        const originalSend = res.send;
        const originalSetHeader = res.setHeader;
        res.setHeader = (name: string, value: string | number | readonly string[]): Response => {
          if (!res.headersSent) {
            originalSetHeader.apply(res, [name, value]);
          }

          return {} as Response;
        };

        res.send = (body: any) => {
          if (res.headersSent) {
            return res;
          }

          return originalSend.apply(res, [body]);
        };

        next();
      });

      if (process.env.LOGGING === "true") {
        app.use((req: express.Request, res: express.Response, next: (err?: any) => void): any => {
          console.log(); // Newline to mark new request
          console.log(`[REST] Received ${req.method} request at ${req.originalUrl}`);
          next();
        });
      }

      // Enforce a timeout on all requests.
      app.use(api.requestTimeoutHandler());

      // Before other middleware which may use request data that this middleware modifies.
      app.use(api.inputSanitizer());

      // body-parser must be before the Application Insights router.
      app.use(bodyParser.urlencoded({ extended: true }));
      const jsonOptions: any = { limit: "10kb", strict: true };
      if (process.env.LOG_INVALID_JSON_REQUESTS === "true") {
        jsonOptions.verify = (req: express.Request, res: express.Response, buf: Buffer, encoding: string) => {
          if (buf && buf.length) {
            (<any>req).rawBody = buf.toString();
          }
        };
      }

      app.use(bodyParser.json(jsonOptions));

      // If body-parser throws an error, catch it and set the request body to null.
      app.use(bodyParserErrorHandler);

      // Before all other middleware to ensure all requests are tracked.
      app.use(appInsights.router());

      app.get("/", (req: express.Request, res: express.Response, next: (err?: Error) => void): any => {
        res.send("Welcome to the CodePush REST API!");
      });

      app.set("etag", false);
      app.set("views", __dirname + "/views");
      app.set("view engine", "ejs");
      app.use("/auth/images/", express.static(__dirname + "/views/images"));
      app.use(api.headers({ origin: process.env.CORS_ORIGIN || "http://localhost:4000" }));
      app.use(api.health({ storage: storage, redisManager: redisManager }));

      if (process.env.DISABLE_ACQUISITION !== "true") {
        app.use(api.acquisition({ storage: storage, redisManager: redisManager }));
      }

      if (process.env.DISABLE_MANAGEMENT !== "true") {
        if (isAuthBypassEnabled()) {
          console.log("WARNING: DEBUG_DISABLE_AUTH is set. The management API is UNAUTHENTICATED.");

          app.use((req, res, next) => {
            let userId: string = "default";
            if (process.env.DEBUG_USER_ID) {
              userId = process.env.DEBUG_USER_ID;
            } else {
              console.log("No DEBUG_USER_ID environment variable configured. Using 'default' as user id");
            }

            req.user = {
              id: userId,
            };

            next();
          });

          app.use(fileUploadMiddleware, api.management({ storage: storage, redisManager: redisManager }));
        } else {
          // auth.authenticate MUST stay inside this branch. Hoisting it above the
          // if/else -- where it lived until the Azure exit -- put the bearer
          // strategy in front of the impersonated user and made the bypass inert.
          app.use(auth.router());
          app.use(auth.authenticate, fileUploadMiddleware, api.management({ storage: storage, redisManager: redisManager }));
        }
      } else {
        app.use(auth.legacyRouter());
      }

      // Error handler needs to be the last middleware so that it can catch all unhandled exceptions
      app.use(appInsights.errorHandler);

      if (isKeyVaultConfigured) {
        // Refresh credentials from the vault regularly as the key is rotated
        setInterval(() => {
          keyvaultClient
            .getSecret(`storage-${process.env.AZURE_STORAGE_ACCOUNT}`)
            .then((secret: any) => {
              return (<AzureStorage>storage).reinitialize(process.env.AZURE_STORAGE_ACCOUNT, secret);
            })
            .catch((error: Error) => {
              console.error("Failed to reinitialize storage from Key Vault credentials");
              appInsights.errorHandler(error);
            })
            .done();
        }, Number(process.env.REFRESH_CREDENTIALS_INTERVAL) || 24 * 60 * 60 * 1000 /*daily*/);
      }

      done(null, app, storage);
    })
    .done();
}
