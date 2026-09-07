// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import * as semver from "semver";

import * as utils from "../utils/common";
import * as acquisitionUtils from "../utils/acquisition";
import * as errorUtils from "../utils/rest-error-handling";
import * as redis from "../redis-manager";
import { MetricsManager } from "../metrics-manager";
import { SingleFlight } from "../single-flight";
import * as restHeaders from "../utils/rest-headers";
import * as rolloutSelector from "../utils/rollout-selector";
import * as storageTypes from "../storage/storage";
import { UpdateCheckCacheResponse, UpdateCheckRequest, UpdateCheckResponse } from "../types/rest-definitions";
import * as validationUtils from "../utils/validation";

import * as q from "q";
import * as queryString from "querystring";
import * as URL from "url";
import Promise = q.Promise;

const METRICS_BREAKING_VERSION = "1.5.2-beta";

// Namespaced so the in-flight map can never be shared with a future caller
// that keys on something else.
const PACKAGE_HISTORY_FLIGHT_PREFIX = "packageHistory:";

export interface AcquisitionConfig {
  storage: storageTypes.Storage;
  // The INTERFACE, not the Redis class. `RedisManager` has private fields, and a
  // class with private fields is not structurally substitutable in TypeScript --
  // so while this was typed as the class, no alternative implementation could be
  // passed in however identical its public surface. The property keeps its
  // historical name; what it holds is whichever manager
  // `createMetricsManager()` selected (metrics-manager.ts).
  redisManager: MetricsManager;
}

/**
 * The cache key for an update_check: the request URL with the per-device id
 * removed, so every device asking the same question shares one cached answer.
 *
 * BOTH SPELLINGS MUST GO. This deleted only the camelCase `clientUniqueId`,
 * but the shipped SDK sends SNAKE_CASE -- `client_unique_id`, alongside
 * `deployment_key` / `app_version` / `package_hash` / `is_companion`
 * (LazyWaitUtil/src/CodePush/vendor/code-push/acquisition-sdk.js:42-50). So the
 * device id survived into the key and the "shared" response cache was actually
 * ONE ENTRY PER DEVICE: near-zero hit rate, every check falling through to
 * storage, and a Redis instance filled with single-use keys. That is a large
 * part of what the cache line item was paying for.
 *
 * createResponseUsingStorage() immediately below reads both spellings for every
 * other parameter, which is how the omission survived review -- the handler was
 * right and only the key builder was wrong.
 *
 * With both deleted the key space collapses to
 * (route, deployment key, app version, package hash, label, is_companion) --
 * a few hundred entries for the whole fleet.
 */
function getUrlKey(originalUrl: string): string {
  const obj: any = URL.parse(originalUrl, /*parseQueryString*/ true);
  delete obj.query.clientUniqueId;
  delete obj.query.client_unique_id;
  return obj.pathname + "?" + queryString.stringify(obj.query);
}

/**
 * The one storage read on the acquisition hot path, de-duplicated per
 * deployment key.
 *
 * WHY THE WRAP IS HERE AND NOT AROUND createResponseUsingStorage():
 * every device on a deployment asks this exact question with this exact
 * argument, so N concurrent cache misses are N copies of ONE query. That
 * matters most in the seconds after a restart, because the in-process response
 * cache (response-cache.ts) does not survive one the way the Redis instance did:
 * every deploy, OOM kill or GHCR-poller restart sends the fleet's next check
 * straight through to the database at once.
 *
 * Sharing one resolved value between requests is sound HERE and nowhere near
 * here: `getUpdatePackage` (utils/acquisition.ts) only READS the history array,
 * building a fresh response object per call. createResponseUsingStorage() by
 * contrast writes the malformed-request errors to `res` itself, so sharing a
 * call to IT would answer one caller and leave the rest hanging until
 * REQUEST_TIMEOUT_IN_MILLISECONDS.
 */
function loadPackageHistory(
  storage: storageTypes.Storage,
  singleFlight: SingleFlight,
  deploymentKey: string
): Promise<storageTypes.Package[]> {
  return singleFlight.run(PACKAGE_HISTORY_FLIGHT_PREFIX + deploymentKey, () =>
    storage.getPackageHistoryFromDeploymentKey(deploymentKey)
  );
}

function createResponseUsingStorage(
  req: express.Request,
  res: express.Response,
  storage: storageTypes.Storage,
  singleFlight: SingleFlight
): Promise<redis.CacheableResponse> {
  const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
  const appVersion: string = String(req.query.appVersion || req.query.app_version);
  const packageHash: string = String(req.query.packageHash || req.query.package_hash);
  const isCompanion: string = String(req.query.isCompanion || req.query.is_companion);

  const updateRequest: UpdateCheckRequest = {
    deploymentKey: deploymentKey,
    appVersion: appVersion,
    packageHash: packageHash,
    isCompanion: isCompanion && isCompanion.toLowerCase() === "true",
    label: String(req.query.label),
  };

  let originalAppVersion: string;

  // Make an exception to allow plain integer numbers e.g. "1", "2" etc.
  const isPlainIntegerNumber: boolean = /^\d+$/.test(updateRequest.appVersion);
  if (isPlainIntegerNumber) {
    originalAppVersion = updateRequest.appVersion;
    updateRequest.appVersion = originalAppVersion + ".0.0";
  }

  // Make an exception to allow missing patch versions e.g. "2.0" or "2.0-prerelease"
  const isMissingPatchVersion: boolean = /^\d+\.\d+([\+\-].*)?$/.test(updateRequest.appVersion);
  if (isMissingPatchVersion) {
    originalAppVersion = updateRequest.appVersion;
    const semverTagIndex = originalAppVersion.search(/[\+\-]/);
    if (semverTagIndex === -1) {
      updateRequest.appVersion += ".0";
    } else {
      updateRequest.appVersion = originalAppVersion.slice(0, semverTagIndex) + ".0" + originalAppVersion.slice(semverTagIndex);
    }
  }

  if (validationUtils.isValidUpdateCheckRequest(updateRequest)) {
    return loadPackageHistory(storage, singleFlight, updateRequest.deploymentKey).then((packageHistory: storageTypes.Package[]) => {
      const updateObject: UpdateCheckCacheResponse = acquisitionUtils.getUpdatePackageInfo(packageHistory, updateRequest);
      if ((isMissingPatchVersion || isPlainIntegerNumber) && updateObject.originalPackage.appVersion === updateRequest.appVersion) {
        // Set the appVersion of the response to the original one with the missing patch version or plain number
        updateObject.originalPackage.appVersion = originalAppVersion;
        if (updateObject.rolloutPackage) {
          updateObject.rolloutPackage.appVersion = originalAppVersion;
        }
      }

      const cacheableResponse: redis.CacheableResponse = {
        statusCode: 200,
        body: updateObject,
      };

      return q(cacheableResponse);
    });
  } else {
    if (!validationUtils.isValidKeyField(updateRequest.deploymentKey)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key - please check that your app has been " +
          "configured correctly. To view available deployment keys, run 'code-push-standalone deployment ls <appName> -k'."
      );
    } else if (!validationUtils.isValidAppVersionField(updateRequest.appVersion)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a binary version that conforms to the semver standard (e.g. '1.0.0'). " +
          "The binary version is normally inferred from the App Store/Play Store version configured with your app."
      );
    } else {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key and provide a semver-compliant app version."
      );
    }

    return q<redis.CacheableResponse>(null);
  }
}

export function getHealthRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: MetricsManager = config.redisManager;
  const router: express.Router = express.Router();

  /**
   * Liveness for the container healthcheck and the load balancer.
   *
   * AN ABSENT REDIS IS HEALTHY. `RedisManager.checkHealth()` *rejects* with
   * "Redis manager is not enabled" when REDIS_HOST/REDIS_PORT are unset
   * (redis-manager.ts:135-138) -- unlike every other method on it, which
   * degrades quietly. Chained unconditionally, that made `/health` a permanent
   * 500 on any deployment without a cache, which is precisely the deployment
   * this service is moving to: the response cache becomes an in-process Map and
   * the metrics move to Postgres, so there is no Redis to point at.
   *
   * A permanent 500 here is not cosmetic. It fails the container healthcheck
   * forever, so the orchestrator reports the service as unhealthy while it is
   * serving update checks perfectly well -- and a restart-on-unhealthy policy
   * would then cycle a container whose only fault is that a cache it no longer
   * needs is absent. Every restart also empties the in-process response cache,
   * sending the whole fleet's next check to the database at once.
   *
   * So: Redis is checked only when it is CONFIGURED. Configured-but-unreachable
   * is still a failure -- that is a real fault. Not configured is a deployment
   * choice and is reported as such, so an operator reading the body can tell
   * "no cache by design" from "cache is broken".
   */
  router.get("/health", (req: express.Request, res: express.Response, next: (err?: any) => void): any => {
    storage
      .checkHealth()
      .then((): q.Promise<boolean> => {
        if (!redisManager.isEnabled) {
          return q(false);
        }

        return redisManager.checkHealth().then((): boolean => true);
      })
      .then((redisChecked: boolean) => {
        res.status(200).send(redisChecked ? "Healthy" : "Healthy (no cache configured)");
      })
      .catch((error: Error) => errorUtils.sendUnknownError(res, error, next))
      .done();
  });

  /**
   * Build identity of the RUNNING PROCESS. Unauthenticated on purpose, and
   * deliberately a SIBLING of /health rather than a change to its body -- the
   * container healthcheck and the Azure App Service probe both only look at the
   * status code, and nothing should have to parse a liveness string to answer a
   * different question.
   *
   * WHY THIS EXISTS AT ALL: the VPS is never pushed to. A cron poller on the box
   * pulls a new :latest digest and swaps the container (deploy/poll-ghcr-codepush.sh),
   * so "CI is green" and "the container is running that build" are two separate
   * facts. In the sibling API repo, telling them apart meant probing for a route
   * that only a new build has -- with a valid bearer token, because everything
   * under /v1/* answers 401 before routing -- and then interpreting a 404 from
   * the catch-all. A shipped feature spent an afternoon looking broken for
   * exactly that reason. One unauthenticated curl now answers it.
   *
   * `storage_backend` is here for the SAME reason during the two-flip cutover:
   * FLIP A moves the network with the Azure data layer untouched and FLIP B
   * swaps only CODEPUSH_STORAGE_BACKEND, so the running image alone does not
   * tell you which data plane is live. It reports the resolved value, matching
   * default-server.ts's own fall-through, not the raw variable.
   *
   * GIT_SHA / BUILD_TIME are baked in as ENV by the runner stage of
   * api/Dockerfile from --build-arg values that CI supplies. A local
   * `npm start` reports "unknown", which is itself the answer to "am I hitting
   * my laptop or the VPS?".
   */
  router.get("/version", (req: express.Request, res: express.Response): any => {
    const sha: string = process.env.GIT_SHA || "unknown";
    res.status(200).json({
      service: "codepush",
      sha: sha,
      short_sha: sha === "unknown" ? "unknown" : sha.substring(0, 7),
      built_at: process.env.BUILD_TIME || "unknown",
      storage_backend: process.env.CODEPUSH_STORAGE_BACKEND === "supabase" ? "supabase" : "azure",
      node: process.version,
      // Seconds since THIS process booted. A restart is also a response-cache
      // flush (the cache is an in-process Map at one replica), so an unexpectedly
      // low uptime during a rollout explains a sudden burst of storage reads.
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  return router;
}

export function getAcquisitionRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: MetricsManager = config.redisManager;
  const router: express.Router = express.Router();

  // Per-router, i.e. one per process. Holds nothing once a load settles -- it is
  // a stampede guard, not a second cache. See loadPackageHistory() above.
  const packageHistoryFlight: SingleFlight = new SingleFlight();

  const updateCheck = function (newApi: boolean) {
    return function (req: express.Request, res: express.Response, next: (err?: any) => void) {
      const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
      const key: string = redis.Utilities.getDeploymentKeyHash(deploymentKey);
      const clientUniqueId: string = String(req.query.clientUniqueId || req.query.client_unique_id);
      const url: string = getUrlKey(req.originalUrl);
      let fromCache: boolean = true;
      let redisError: Error;

      redisManager
        .getCachedResponse(key, url)
        .catch((error: Error) => {
          // Store the redis error to be thrown after we send response.
          redisError = error;
          return q<redis.CacheableResponse>(null);
        })
        .then((cachedResponse: redis.CacheableResponse) => {
          fromCache = !!cachedResponse;
          return cachedResponse || createResponseUsingStorage(req, res, storage, packageHistoryFlight);
        })
        .then((response: redis.CacheableResponse) => {
          if (!response) {
            return q<void>(null);
          }

          let giveRolloutPackage: boolean = false;
          const cachedResponseObject = <UpdateCheckCacheResponse>response.body;
          if (cachedResponseObject.rolloutPackage && clientUniqueId) {
            const releaseSpecificString: string =
              cachedResponseObject.rolloutPackage.label || cachedResponseObject.rolloutPackage.packageHash;
            giveRolloutPackage = rolloutSelector.isSelectedForRollout(
              clientUniqueId,
              cachedResponseObject.rollout,
              releaseSpecificString
            );
          }

          const updateCheckBody: { updateInfo: UpdateCheckResponse } = {
            updateInfo: giveRolloutPackage ? cachedResponseObject.rolloutPackage : cachedResponseObject.originalPackage,
          };

          // Change in new API
          updateCheckBody.updateInfo.target_binary_range = updateCheckBody.updateInfo.appVersion;

          res.locals.fromCache = fromCache;
          res.status(response.statusCode).send(newApi ? utils.convertObjectToSnakeCase(updateCheckBody) : updateCheckBody);

          // Update REDIS cache after sending the response so that we don't block the request.
          if (!fromCache) {
            return redisManager.setCachedResponse(key, url, response);
          }
        })
        .then(() => {
          if (redisError) {
            throw redisError;
          }
        })
        .catch((error: storageTypes.StorageError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    };
  };

  const reportStatusDeploy = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    const appVersion = req.body.appVersion || req.body.app_version;
    const previousDeploymentKey = req.body.previousDeploymentKey || req.body.previous_deployment_key || deploymentKey;
    const previousLabelOrAppVersion = req.body.previousLabelOrAppVersion || req.body.previous_label_or_app_version;
    const clientUniqueId = req.body.clientUniqueId || req.body.client_unique_id;

    if (!deploymentKey || !appVersion) {
      return errorUtils.sendMalformedRequestError(res, "A deploy status report must contain a valid appVersion and deploymentKey.");
    } else if (req.body.label) {
      if (!req.body.status) {
        return errorUtils.sendMalformedRequestError(res, "A deploy status report for a labelled package must contain a valid status.");
      } else if (!redis.Utilities.isValidDeploymentStatus(req.body.status)) {
        return errorUtils.sendMalformedRequestError(res, "Invalid status: " + req.body.status);
      }
    }

    const sdkVersion: string = restHeaders.getSdkVersion(req);
    if (semver.valid(sdkVersion) && semver.gte(sdkVersion, METRICS_BREAKING_VERSION)) {
      // If previousDeploymentKey not provided, assume it is the same deployment key.
      let redisUpdatePromise: q.Promise<void>;

      if (req.body.label && req.body.status === redis.DEPLOYMENT_FAILED) {
        redisUpdatePromise = redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status);
      } else {
        const labelOrAppVersion: string = req.body.label || appVersion;
        redisUpdatePromise = redisManager.recordUpdate(
          deploymentKey,
          labelOrAppVersion,
          previousDeploymentKey,
          previousLabelOrAppVersion
        );
      }

      redisUpdatePromise
        .then(() => {
          res.sendStatus(200);
          if (clientUniqueId) {
            redisManager.removeDeploymentKeyClientActiveLabel(previousDeploymentKey, clientUniqueId);
          }
        })
        .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
        .done();
    } else {
      if (!clientUniqueId) {
        return errorUtils.sendMalformedRequestError(
          res,
          "A deploy status report must contain a valid appVersion, clientUniqueId and deploymentKey."
        );
      }

      return redisManager
        .getCurrentActiveLabel(deploymentKey, clientUniqueId)
        .then((currentVersionLabel: string) => {
          if (req.body.label && req.body.label !== currentVersionLabel) {
            return redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status).then(() => {
              if (req.body.status === redis.DEPLOYMENT_SUCCEEDED) {
                return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, req.body.label, currentVersionLabel);
              }
            });
          } else if (!req.body.label && appVersion !== currentVersionLabel) {
            return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, appVersion, appVersion);
          }
        })
        .then(() => {
          res.sendStatus(200);
        })
        .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
        .done();
    }
  };

  const reportStatusDownload = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    if (!req.body || !deploymentKey || !req.body.label) {
      return errorUtils.sendMalformedRequestError(
        res,
        "A download status report must contain a valid deploymentKey and package label."
      );
    }
    return redisManager
      .incrementLabelStatusCount(deploymentKey, req.body.label, redis.DOWNLOADED)
      .then(() => {
        res.sendStatus(200);
      })
      .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
      .done();
  };

  router.get("/updateCheck", updateCheck(false));
  router.get("/v0.1/public/codepush/update_check", updateCheck(true));

  router.post("/reportStatus/deploy", reportStatusDeploy);
  router.post("/v0.1/public/codepush/report_status/deploy", reportStatusDeploy);

  router.post("/reportStatus/download", reportStatusDownload);
  router.post("/v0.1/public/codepush/report_status/download", reportStatusDownload);

  return router;
}
