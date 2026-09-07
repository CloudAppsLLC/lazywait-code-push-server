// LazyWait legacy-URL reverse proxy for CodePush.
// Licensed under the MIT License (same terms as the fork it sits in front of).
//
// WHY THIS EXISTS
// ---------------
// `codepushapp-dvgsdugfg8d0a4f0.uaenorth-01.azurewebsites.net` lives in
// Microsoft's DNS zone. We cannot repoint it, and it is COMPILED INTO EVERY
// SHIPPED BINARY:
//
//   LazyWaitOne/android/app/src/main/res/values/strings.xml:9
//   LazyWaitOne/ios/lazywaitone/Info.plist:53
//   LazyWaitOne/windows/lazywaitone/lazywaitone.cpp:374
//   LazyWaitOne/windows.paper/lazywaitone/App.xaml.cs:145
//
// The native layer reads it directly and JS can override only the deployment
// KEY, never the server URL (LazyWaitUtil/src/CodePush/CodePush.js:102 --
// `sync()`'s option bag has no serverUrl). So the last OTA bundle we ever serve
// from Azure cannot tell a device to go somewhere else. Devices in the field
// keep calling that hostname until they take a new STORE build, which for some
// tills is never.
//
// Therefore the App Service survives FLIP A as a transparent pipe to
// codepush.lazywait.com, downgraded S1 -> B1 (~SR49/mo), until distinct-device
// telemetry says it is safe to delete. See ../legacy-proxy/README.md.
//
// DESIGN RULES (deliberate, do not "improve"):
//   * It is a PIPE. No auth, no caching, no body inspection, no rewriting of
//     request or response bodies, no route table. Every method, every path,
//     every query string, every header, every byte.
//   * It has NO dependency on any CodePush source file. It must keep working
//     when the fork's code changes shape, and it must be deployable without
//     building the server.
//   * It STREAMS. See the "DO BUNDLE BYTES FLOW THROUGH HERE" note below.
//
// DO BUNDLE BYTES FLOW THROUGH HERE? ALMOST NEVER -- AND THAT IS WHY B1 IS ENOUGH.
// -------------------------------------------------------------------------------
// An update_check response carries `download_url` as an ABSOLUTE URL pointing
// straight at object storage -- `latestSatisfyingEnabledPackage.blobUrl`, or
// the diff's `diffPackageMap[hash].url`
// (api/script/utils/acquisition.ts:112-121). Today that host is Azure Blob
// Storage; after FLIP B it is Supabase Storage. Either way the device fetches
// the ~13 MB gzipped bundle from the storage host DIRECTLY. It never traverses
// the CodePush server, so it never traverses this proxy. What crosses this
// process is update_check (a few hundred bytes) and report_status/{deploy,
// download} (a JSON object each) -- which is why a 1-core B1 with no scale-out
// is not a bottleneck.
//
// The ONE exception is a MANAGEMENT release upload (`POST /apps/:app/
// deployments/:dep/release`, a ~30 MB multipart zip). Nothing should send that
// here after FLIP A -- the CLI, `yarn release:*` and the ERP CodePush page all
// point at CODEPUSH_BASE_URL, which moves to codepush.lazywait.com -- but a
// developer with a stale `~/.code-push.config` still can. That path is the only
// reason the streaming below is load-bearing rather than merely tidy: buffering
// it would put a 30 MB allocation on a 1.75 GB box for no reason, and Azure's
// front end would kill it before an upload finished anyway (see AZURE_HARD_
// TIMEOUT_MS).

import * as express from "express";
import * as http from "http";
import * as https from "https";
import { URL } from "url";

// The upstream this pipe points at. Configured, never hardcoded, so the same
// artifact can be aimed at codepush-dev.lazywait.com during the soak rehearsal.
const UPSTREAM_RAW: string = process.env.CODEPUSH_UPSTREAM || "https://codepush.lazywait.com";

// Deliberately generous, and deliberately paired with the two OTHER timeouts in
// the chain so the binding constraint is knowable:
//   * Caddy's codepush vhost:      read_timeout / write_timeout 300s
//   * The fork's own app timeout:  REQUEST_TIMEOUT_IN_MILLISECONDS, which
//     ANSWERS 408 (api/script/routes/request-timeout.ts:6,9-11)
// so 300000 here means this proxy is never the thing that gives up first.
const UPSTREAM_TIMEOUT_MS: number = Number(process.env.CODEPUSH_UPSTREAM_TIMEOUT_MS || 300000);

// Not a setting -- a fact about the platform, recorded so nobody spends an
// afternoon on it. Azure App Service's front end (ARR) hard-closes an inbound
// connection at 230 seconds and there is no knob for it on B1. Any request that
// would legitimately run longer than that CANNOT be served through the legacy
// hostname regardless of what we set above. Only a release upload gets near it,
// and release uploads should not be arriving here at all.
const AZURE_HARD_TIMEOUT_MS = 230000;

// Stamped on every proxied request so the upstream Caddy access log can tell
// legacy-URL traffic from direct traffic. THIS HEADER IS THE ENTIRE RETIREMENT
// SIGNAL for the App Service -- see README.md "Retirement criteria". Set LAST,
// after the client's own headers are copied, so a client cannot suppress it.
const LEGACY_HOST_HEADER = "x-legacy-host";
const LEGACY_HOST_VALUE = "azure";

// RFC 7230 6.1: connection-scoped headers must not be forwarded. `host` is
// handled separately (it is rewritten, not dropped) and `transfer-encoding` is
// dropped so Node re-frames the body itself.
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const upstream = new URL(UPSTREAM_RAW);
const isTls: boolean = upstream.protocol === "https:";
const transport: typeof http | typeof https = isTls ? https : http;

// keepAlive matters here: a fleet of tills polling every launch would otherwise
// pay a TLS handshake to the VPS on every single update_check.
const AGENT_OPTIONS: http.AgentOptions = {
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 256,
  maxFreeSockets: 32,
};
const agent: http.Agent = isTls ? new https.Agent(AGENT_OPTIONS) : new http.Agent(AGENT_OPTIONS);

const app: express.Express = express();

// No body parser is registered ANYWHERE in this file, on purpose. Registering
// one would consume `req` as a stream and force us to re-serialise the body --
// which is exactly the "no body rewriting" rule, and the difference between
// piping a 30 MB upload and buffering it.
app.disable("x-powered-by");
app.set("trust proxy", true);

/**
 * Local liveness probe.
 *
 * The one deliberate deviation from "everything is proxied". `/health` is a
 * real CodePush route (api/script/routes/acquisition.ts:166) and it is proxied
 * like everything else -- which means during the soak a 502 from `/health`
 * cannot distinguish "this proxy is dead" from "the VPS is unreachable". That
 * distinction is the first question anyone asks at 2am, so it gets its own
 * path. The `__` prefix cannot collide: the fork mounts nothing outside
 * /health, /auth/*, /apps/*, /accessKeys/*, /updateCheck, /reportStatus/* and
 * /v0.1/public/codepush/*.
 */
app.get("/__legacy_proxy_health", (_req: express.Request, res: express.Response): void => {
  res.status(200).json({
    proxy: "lazywait-codepush-legacy-proxy",
    upstream: upstream.origin,
    upstream_timeout_ms: UPSTREAM_TIMEOUT_MS,
    uptime_seconds: Math.round(process.uptime()),
  });
});

function buildOutboundHeaders(req: express.Request): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};

  for (const name of Object.keys(req.headers)) {
    const lower: string = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // Caddy routes by Host. Forwarding the Azure hostname makes the codepush
    // vhost not match and Caddy answers 404 for everything -- which looks
    // exactly like "the container is down" and is not.
    if (lower === "host") continue;
    const value: string | string[] | undefined = req.headers[name];
    if (value !== undefined) headers[lower] = value;
  }

  headers.host = upstream.host;

  // Azure App Service already sets these; the fallback is for a local run.
  // `trust proxy` is on in the fork (api/script/server.ts:14) and getIpAddress
  // reads x-forwarded-for first (api/script/utils/rest-headers.ts:29-40), so
  // this is what the fork's per-IP rate limiters key on.
  if (!headers["x-forwarded-for"] && req.socket.remoteAddress) {
    headers["x-forwarded-for"] = req.socket.remoteAddress;
  }
  if (!headers["x-forwarded-proto"]) {
    headers["x-forwarded-proto"] = req.protocol;
  }
  if (!headers["x-forwarded-host"] && req.headers.host) {
    headers["x-forwarded-host"] = req.headers.host;
  }

  headers[LEGACY_HOST_HEADER] = LEGACY_HOST_VALUE;
  return headers;
}

function copyResponseHeaders(upstreamRes: http.IncomingMessage, res: express.Response): void {
  for (const name of Object.keys(upstreamRes.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    const value: string | string[] | undefined = upstreamRes.headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
}

function proxy(req: express.Request, res: express.Response): void {
  const startedAt: number = Date.now();

  const options: https.RequestOptions = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (isTls ? 443 : 80),
    method: req.method,
    // `originalUrl` because it carries the query string verbatim. Re-encoding
    // it through a URL object would normalise characters the fork's own cache
    // key builder (getUrlKey, api/script/routes/acquisition.ts) hashes on.
    path: req.originalUrl,
    headers: buildOutboundHeaders(req),
    agent,
  };

  const upstreamReq: http.ClientRequest = transport.request(options, (upstreamRes: http.IncomingMessage): void => {
    copyResponseHeaders(upstreamRes, res);
    res.status(upstreamRes.statusCode || 502);
    // STREAM. Never `stream-to-array`, never a Buffer.concat. The response we
    // care least about buffering is also the one most likely to be large: a
    // 200 from a management GET on an app with a long package history.
    upstreamRes.pipe(res);
    upstreamRes.on("error", (): void => {
      res.destroy();
    });
    upstreamRes.on("end", (): void => {
      log(req, upstreamRes.statusCode || 0, Date.now() - startedAt);
    });
  });

  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, (): void => {
    upstreamReq.destroy(new Error(`upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms`));
  });

  upstreamReq.on("error", (err: Error): void => {
    // Headers already flushed means the failure happened mid-body; there is no
    // status code left to send and a partial body must not be passed off as
    // complete. Kill the socket so the client sees a truncated transfer rather
    // than a silently short bundle manifest.
    if (res.headersSent) {
      log(req, -1, Date.now() - startedAt, err);
      res.destroy();
      return;
    }
    log(req, 502, Date.now() - startedAt, err);
    res.status(502).json({
      error: "bad_gateway",
      message: "The legacy CodePush proxy could not reach the upstream server.",
      upstream: upstream.origin,
    });
  });

  // If the device hangs up (a till on a flaky link, which is most of them),
  // stop holding a socket to the VPS open on its behalf.
  req.on("aborted", (): void => {
    upstreamReq.destroy();
  });

  // The only place the request body is touched: it is piped, byte for byte.
  req.pipe(upstreamReq);
}

/**
 * One line per request, to stdout, for the App Service log stream.
 *
 * The QUERY STRING IS DELIBERATELY OMITTED. It carries `deployment_key`, which
 * is compiled into shipped binaries and must never be regenerated -- it does
 * not belong in a log anyone can tail. The retirement count is not computed
 * here anyway: it comes from the UPSTREAM Caddy access log, which sees both the
 * query string and the X-Legacy-Host stamp in one record (README.md).
 */
function log(req: express.Request, status: number, ms: number, err?: Error): void {
  const path: string = req.originalUrl.split("?")[0];
  const suffix: string = err ? ` err=${err.message}` : "";
  const code: string = status < 0 ? "ABORTED" : String(status);
  console.log(`[legacy-proxy] ${code} ${req.method} ${path} ${ms}ms${suffix}`);
}

app.use(proxy);

// Azure App Service injects PORT. 8080 is only for `npm start` on a laptop.
const port: number = Number(process.env.PORT || 8080);
const server: http.Server = app.listen(port, (): void => {
  console.log(`[legacy-proxy] listening on :${port} -> ${upstream.origin}`);
  console.log(`[legacy-proxy] stamping ${LEGACY_HOST_HEADER}: ${LEGACY_HOST_VALUE} on every request`);
  console.log(`[legacy-proxy] upstream timeout ${UPSTREAM_TIMEOUT_MS}ms (Azure front end caps at ${AZURE_HARD_TIMEOUT_MS}ms)`);
});

// Node's default is 5s, which is shorter than the 240s idle timeout of the
// Azure front end sitting in front of us -- the classic ECONNRESET-on-an-idle-
// keepalive-socket race. Outlast it.
server.keepAliveTimeout = 245000;
server.headersTimeout = 250000;
