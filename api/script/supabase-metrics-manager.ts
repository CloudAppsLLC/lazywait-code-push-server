// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//
// =============================================================================
// THE REDIS-FREE MANAGER: in-process response cache + Postgres deployment
// metrics. Selected with CODEPUSH_METRICS_BACKEND=supabase.
// =============================================================================
//
// It implements `MetricsManager` (metrics-manager.ts), which is `RedisManager`'s
// public surface extracted verbatim, so the routers cannot tell the difference.
// What it removes is the Azure Redis Cache instance -- ~SR385/month at
// full-month run rate, and the last stateful Azure resource in the request path
// besides the table and the blobs.
//
// -----------------------------------------------------------------------------
// !! DEPLOYMENT INVARIANT: EXACTLY ONE REPLICA. THIS IS NOT AN IMPLEMENTATION
// !! DETAIL, IT IS A CONSTRAINT ON HOW THIS SERVICE MAY BE RUN.
// -----------------------------------------------------------------------------
// The response cache lives in THIS PROCESS's memory. `invalidateCache` is called
// by `routes/management.ts` (`invalidateCachedPackage`) after every release,
// promote, rollback, patch, disable/enable and history clear, and it is the ONLY
// mechanism that makes a new release visible to the fleet before the one-hour
// TTL expires. An in-process cache can only be invalidated in the process that
// holds it.
//
// So with two replicas behind a load balancer, a release invalidates ONE of
// them. The other keeps answering `is_available:false` -- correctly formed, HTTP
// 200, nothing logged anywhere -- to whichever half of the fleet it happens to
// serve, for up to an hour. That is indistinguishable from "the release did not
// work", and it is the single most likely way this migration breaks OTA without
// anybody noticing.
//
// Concretely, until this cache is externalised again (a `LISTEN`/`NOTIFY` fan-out
// or a shared cache would both do it):
//   * ONE container. Do not scale the compose service, do not add a second
//     replica "for availability", do not put an upstream POOL in the Caddy
//     block -- a single `reverse_proxy` target only.
//   * The in-process `express-rate-limit` budgets in `passport-authentication.ts`
//     and on the release route have exactly the same property, so this
//     constraint is not new with this file -- it is now merely load-bearing for
//     correctness rather than only for fairness.
//   * A restart is a cache FLUSH. Do not restart during a rollout, and gate the
//     GHCR poller off release windows (design section C.1). The stampede that
//     follows a flush is what `SingleFlight` in the acquisition router exists to
//     absorb.
//
// -----------------------------------------------------------------------------
// METRICS: WHY THE RPC TAKES AN ARRAY
// -----------------------------------------------------------------------------
// `recordUpdate` is not a single-key operation and never was. It writes +1
// Active and +1 DeploymentSucceeded against the CURRENT deployment key, and -1
// Active against the PREVIOUS one -- and the previous key comes straight off the
// request body (`previousDeploymentKey`, routes/acquisition.ts). After a
// Staging -> Production promote those two keys are DIFFERENT deployments. A
// single-key RPC would apply the decrement to Production, leaving Staging's
// Active count over-reporting every device that ever moved off it, forever, with
// no way to re-derive the truth (status reports are fire-and-forget; Redis was
// the only copy). Hence `codepush_bump_metrics(p_entries JSONB)`, a JSON ARRAY
// of `{deployment_key, label, status, delta}` applied in one statement per
// entry inside one transaction (migration 803).
//
// The RPC drops -- and does not fail on -- an entry whose deployment key is
// unknown. That is deliberate: a device reporting against a deployment that has
// since been deleted must not 500 its way into a retry loop.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT PORTED: THE PER-CLIENT `deploymentKeyClients` HASH
// -----------------------------------------------------------------------------
// Redis kept a hash of clientUniqueId -> current label PER DEPLOYMENT KEY. That
// is one Redis field per device in the fleet, and reproducing it in Postgres
// means a row per device per deployment on the hot path -- the single most
// expensive thing Redis was doing for us, in service of a code path the modern
// SDK does not use. `updateActiveAppForClient` and
// `removeDeploymentKeyClientActiveLabel` are therefore NO-OPS here, and
// `getCurrentActiveLabel` always resolves null.
//
// THE METHODS STAY. Deleting them would compile (the interface is what the
// routes see) but `removeDeploymentKeyClientActiveLabel` is called on the
// MODERN path -- inside the `semver.gte(sdkVersion, "1.5.2-beta")` branch,
// AFTER `res.sendStatus(200)` -- so a missing method would be a post-response
// TypeError thrown inside a `q` chain, routed through
// `express-domain-middleware` into a response whose `send` has already been
// monkey-patched to a no-op (`default-server.ts`). Completely invisible.
//
// THE COST, STATED PLAINLY: a client whose SDK version header is absent or not
// semver takes the deprecated branch, where the Active count was maintained by
// `updateActiveAppForClient`. Those clients stop contributing to Active. Their
// DeploymentSucceeded / DeploymentFailed / Downloaded counts are unaffected
// (`incrementLabelStatusCount` is real), and the modern branch -- which is what
// `LazyWaitUtil`'s bundled SDK reports itself as -- maintains Active through
// `recordUpdate`. Accepted deliberately: the alternative is a per-device table
// on the write path of every status report in the fleet.
//

import * as q from "q";

import { ACTIVE, CacheableResponse, DEPLOYMENT_SUCCEEDED, DeploymentMetrics, Utilities } from "./redis-manager";
import { MetricsManager } from "./metrics-manager";
import { ResponseCache, ResponseCacheOptions } from "./response-cache";
import { SupabaseClient, SupabaseClientOptions } from "@supabase/supabase-js";

// Same project, same credentials and the SAME error mapper as the storage
// backend -- a 42P01 ("migration 803 is not applied here") must read identically
// whichever of the two hits it first. `toStorageError` is imported rather than
// re-implemented for exactly that reason.
import { ENV_CODEPUSH_JWT, ENV_SUPABASE_URL, toStorageError } from "./storage/supabase-storage";

const TABLE_METRIC = "codepush_deployment_metric";
const TABLE_DEPLOYMENT = "codepush_deployment";
const RPC_BUMP_METRICS = "codepush_bump_metrics";

// Annotated `: string` on purpose, exactly as in supabase-storage.ts:
// `@supabase/supabase-js` parses the select string IN THE TYPE SYSTEM, and an
// embedded resource against an untyped schema costs a "TS2589: Type
// instantiation is excessively deep" on the build. Widening to `string` makes
// the parser bow out; the row shape is asserted by the interfaces below and
// proved by the conformance harness.
//
// ONE SELECT, with the deployment joined INNER purely to translate the
// deployment KEY (what every caller has) into the deployment ID (what the table
// is keyed by). This depends on PostgREST having detected the
// codepush_deployment_metric -> codepush_deployment foreign key; migration 803
// ends with `NOTIFY pgrst, 'reload schema'` for that reason. If it ever answers
// PGRST200 ("could not find a relationship"), the schema cache is stale -- the
// fix is a reload, not two round trips here.
const METRIC_SELECT: string = "label,status,count,codepush_deployment!inner(deployment_key)";

interface MetricRow {
  label: string;
  status: string;
  count: number | string;
}

/**
 * One entry of the `codepush_bump_metrics` array argument. SNAKE_CASE because
 * this object is serialised straight into the JSONB parameter -- these are the
 * key names the RPC reads (`e->>'deployment_key'` and friends), not a TypeScript
 * convention.
 */
export interface MetricEntry {
  deployment_key: string;
  label: string;
  status: string;
  delta: number;
}

/**
 * The persistence seam. Production uses `PostgresMetricSink`; the conformance
 * harness substitutes an in-memory recorder so the entry ARRAY built by
 * `recordUpdate` -- the multi-key behaviour that a single-key design gets wrong
 * -- can be asserted without a database.
 */
export interface MetricSink {
  bump(entries: MetricEntry[]): Promise<void>;
  read(deploymentKey: string): Promise<MetricRow[]>;
  clear(deploymentKey: string): Promise<void>;
  check(): Promise<void>;
}

export interface SupabaseMetricsManagerOptions {
  // Pass `null` to construct a manager whose metrics are explicitly disabled
  // (isEnabled === false) while the response cache still works. Omit it to
  // resolve a Postgres sink from the environment.
  sink?: MetricSink;
  cache?: ResponseCache;
  cacheOptions?: ResponseCacheOptions;
}

export class PostgresMetricSink implements MetricSink {
  private _client: SupabaseClient;

  public constructor(url: string, jwt: string) {
    // TWO HEADERS, TWO DIFFERENT CREDENTIALS -- the same trap supabase-storage.ts
    // documents, and this file walked straight into it.
    //
    // `new SupabaseClient(url, key)` sets BOTH `apikey: key` and
    // `Authorization: Bearer key`. Supabase Cloud's gateway authenticates
    // `apikey` against the project's OWN issued keys, so a self-signed
    // codepush_api JWT there is rejected at the edge -- before PostgREST, before
    // any role or policy -- as {"message":"Invalid API key"}.
    //
    // It surfaced as `code-push-standalone deployment ls <app>` returning a bare
    // "Internal Server Error" while `app ls` worked perfectly: app listing goes
    // through the STORAGE adapter (already fixed), and only deployment listing
    // reaches the metrics client. Two clients, one fixed and one not, so the
    // failure looked like a routing or permissions problem rather than a
    // credential-shape one.
    //
    // apikey = the anon key: identifies the PROJECT, authorises nothing (803
    // revokes anon from every codepush_* table).
    // Authorization = the codepush_api JWT: identifies the ROLE.
    const apiKey: string =
      process.env.SUPABASE_CODEPUSH_APIKEY || process.env.SUPABASE_ANON_KEY || "";

    if (!apiKey) {
      throw new Error(
        "Supabase metrics: SUPABASE_CODEPUSH_APIKEY (or SUPABASE_ANON_KEY) is required. " +
          "It is the project's anon key and is sent ONLY as the 'apikey' gateway header."
      );
    }

    const clientOptions: SupabaseClientOptions<"public"> = {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: {
          "x-client-info": "lazywait-codepush-metrics",
          Authorization: `Bearer ${jwt}`,
        },
      },
    };

    this._client = new SupabaseClient(url, apiKey, clientOptions);
  }

  /**
   * Resolve a sink from the environment, or null when this deployment has no
   * Postgres configured. Null is reported honestly through `isEnabled` rather
   * than being papered over -- see the `isEnabled` contract in
   * metrics-manager.ts.
   */
  public static fromEnvironment(): PostgresMetricSink {
    const url: string = process.env[ENV_SUPABASE_URL];
    const jwt: string = process.env[ENV_CODEPUSH_JWT];

    if (!url || !jwt) {
      // Mirrors RedisManager's own "No REDIS_HOST or REDIS_PORT environment
      // variable configured." warning: a metrics backend that is silently absent
      // has to say so at boot, because the symptom downstream is an empty
      // CodePush metrics page with a 200 next to it.
      console.warn(
        `[codepush-metrics] ${ENV_SUPABASE_URL} and ${ENV_CODEPUSH_JWT} are both required for the Postgres metrics backend; ` +
          `deployment metrics are DISABLED (the in-process response cache is unaffected).`
      );
      return null;
    }

    return new PostgresMetricSink(url, jwt);
  }

  public async bump(entries: MetricEntry[]): Promise<void> {
    if (!entries.length) {
      return;
    }

    const { error } = await this._client.rpc(RPC_BUMP_METRICS, { p_entries: entries });

    if (error) {
      throw toStorageError(error, "Failed to record CodePush deployment metrics");
    }
  }

  public async read(deploymentKey: string): Promise<MetricRow[]> {
    const { data, error } = await this._client
      .from(TABLE_METRIC)
      .select(METRIC_SELECT)
      .eq("codepush_deployment.deployment_key", deploymentKey);

    if (error) {
      throw toStorageError(error, "Failed to read CodePush deployment metrics");
    }

    return <MetricRow[]>(<unknown>(data || []));
  }

  public async clear(deploymentKey: string): Promise<void> {
    // Two round trips, unlike `read`: PostgREST can only filter a DELETE on the
    // target table's own columns, so the key -> id translation cannot ride along
    // in the same statement. This runs on the history-clear admin path, not on
    // anything a device touches.
    const { data, error } = await this._client.from(TABLE_DEPLOYMENT).select("id").eq("deployment_key", deploymentKey).maybeSingle();

    if (error) {
      throw toStorageError(error, "Failed to resolve the deployment for a metrics clear");
    }

    const row = <{ id: string }>(<unknown>data);
    if (!row) {
      // The deployment is gone; its metrics went with it via ON DELETE CASCADE.
      // Redis's `del` on a missing hash was likewise a no-op, and the caller
      // (`routes/management.ts`) treats this as success.
      return;
    }

    const deleted = await this._client.from(TABLE_METRIC).delete().eq("deployment_id", row.id);
    if (deleted.error) {
      throw toStorageError(deleted.error, "Failed to clear CodePush deployment metrics");
    }
  }

  public async check(): Promise<void> {
    // A real round trip, and the cheapest one that proves what can actually be
    // broken: the project resolves, the JWT is valid, `codepush_api` has its
    // GRANT, RLS is not denying us and migration 803 is applied. `head` reads no
    // rows, so a database with no metrics yet is still healthy.
    const { error } = await this._client.from(TABLE_METRIC).select("deployment_id", { head: true }).limit(1);

    if (error) {
      throw toStorageError(error, "The CodePush metrics table failed the health check");
    }
  }
}

export class SupabaseMetricsManager implements MetricsManager {
  private _cache: ResponseCache;
  private _sink: MetricSink;

  public constructor(options?: SupabaseMetricsManagerOptions) {
    const resolved: SupabaseMetricsManagerOptions = options || {};

    this._cache = resolved.cache || new ResponseCache(resolved.cacheOptions);
    // `!== undefined`, not `||`: an explicit `sink: null` means "metrics off",
    // which the harness uses and which a cache-only deployment is entitled to.
    this._sink = resolved.sink !== undefined ? resolved.sink : PostgresMetricSink.fromEnvironment();
  }

  /**
   * Reports whether METRICS are available -- deliberately NOT whether the cache
   * is.
   *
   * In `RedisManager` one flag governed both, because one Redis instance backed
   * both. Here the response cache is in-process and therefore ALWAYS available,
   * while the metrics need Postgres. The three call sites all ask the metrics
   * question: `routes/management.ts` guards the metrics endpoint and the
   * post-clear metrics wipe with it, and `/health` uses it to decide whether
   * there is anything to probe. Reporting the cache's availability here would
   * make the metrics endpoint 500 on a deployment with no database.
   */
  public get isEnabled(): boolean {
    return !!this._sink;
  }

  /**
   * MUST NOT REJECT WHEN THERE IS NOTHING TO CHECK.
   *
   * `RedisManager.checkHealth()` is the one method on it that rejects instead of
   * degrading (`q.reject("Redis manager is not enabled")`), and `/health` chains
   * it. That made `/health` a permanent 500 -- and therefore the container
   * permanently unhealthy, and therefore restart-cycled under a
   * restart-on-unhealthy policy -- on any deployment without a cache. Every
   * restart also flushes this cache. Do not reintroduce that shape.
   */
  public checkHealth(): q.Promise<void> {
    if (!this._sink) {
      return q<void>(null);
    }

    return q(this._sink.check());
  }

  // -- response cache ---------------------------------------------------------
  //
  // Always live, with or without a metrics sink: it is this process's own
  // memory. All three keep RedisManager's signatures so the routers are
  // unchanged.

  public getCachedResponse(expiryKey: string, url: string): q.Promise<CacheableResponse> {
    return q<CacheableResponse>(this._cache.get(expiryKey, url));
  }

  public setCachedResponse(expiryKey: string, url: string, response: CacheableResponse): q.Promise<void> {
    this._cache.set(expiryKey, url, response);
    return q<void>(null);
  }

  public invalidateCache(expiryKey: string): q.Promise<void> {
    this._cache.invalidate(expiryKey);
    return q<void>(null);
  }

  // -- metrics ----------------------------------------------------------------

  public incrementLabelStatusCount(deploymentKey: string, label: string, status: string): q.Promise<void> {
    if (!this._sink) {
      return q<void>(null);
    }

    // `Utilities.getLabelStatusField` returns NULL for a status outside
    // {DeploymentSucceeded, DeploymentFailed, Downloaded}, and Redis then wrote
    // a field literally named "null". Here that would be a row in a table with a
    // primary key, so the entry is dropped instead. The routes validate status
    // before calling, so this is defence in depth, not a live path.
    if (!Utilities.isValidDeploymentStatus(status) || !label) {
      return q<void>(null);
    }

    return q(this._sink.bump([{ deployment_key: deploymentKey, label: label, status: status, delta: 1 }]));
  }

  /**
   * The multi-key write. Mirrors `RedisManager.recordUpdate` batch for batch:
   * +1 Active and +1 DeploymentSucceeded on the CURRENT key/label, -1 Active on
   * the PREVIOUS one -- which after a promote is a DIFFERENT deployment. All of
   * it in one RPC call, i.e. one transaction, where Redis used one MULTI.
   */
  public recordUpdate(
    currentDeploymentKey: string,
    currentLabel: string,
    previousDeploymentKey?: string,
    previousLabel?: string
  ): q.Promise<void> {
    if (!this._sink) {
      return q<void>(null);
    }

    const entries: MetricEntry[] = [];

    if (currentLabel) {
      entries.push({ deployment_key: currentDeploymentKey, label: currentLabel, status: ACTIVE, delta: 1 });
      entries.push({ deployment_key: currentDeploymentKey, label: currentLabel, status: DEPLOYMENT_SUCCEEDED, delta: 1 });
    }

    if (previousDeploymentKey && previousLabel) {
      entries.push({ deployment_key: previousDeploymentKey, label: previousLabel, status: ACTIVE, delta: -1 });
    }

    return q(this._sink.bump(entries));
  }

  public clearMetricsForDeploymentKey(deploymentKey: string): q.Promise<void> {
    if (!this._sink) {
      return q<void>(null);
    }

    return q(this._sink.clear(deploymentKey));
  }

  /**
   * Re-keyed as `label + ":" + status`, which is the shape
   * `utils/converter.ts:toRestDeploymentMetrics` splits on. That function is
   * deliberately UNCHANGED by this migration: it is what the CLI and the ERP
   * CodePush page both render, and it is the one place where "the metrics moved
   * to Postgres" must be invisible.
   */
  public getMetricsWithDeploymentKey(deploymentKey: string): q.Promise<DeploymentMetrics> {
    if (!this._sink) {
      return q<DeploymentMetrics>(null);
    }

    return q(this.readMetricsAsync(deploymentKey));
  }

  private async readMetricsAsync(deploymentKey: string): Promise<DeploymentMetrics> {
    const rows: MetricRow[] = await this._sink.read(deploymentKey);
    const metrics: DeploymentMetrics = {};

    rows.forEach((row: MetricRow) => {
      // `count` is BIGINT. PostgREST serialises it as a JSON number here, but
      // Redis handed back strings and the old manager coerced -- keep coercing,
      // because converter.ts does `+=` on these and a string would concatenate.
      const parsed: number = Number(row.count);
      metrics[`${row.label}:${row.status}`] = isNaN(parsed) ? 0 : parsed;
    });

    return metrics;
  }

  // -- deprecated per-client tracking (no-ops -- see the file header) ----------

  public removeDeploymentKeyClientActiveLabel(deploymentKey: string, clientUniqueId: string): q.Promise<void> {
    return q<void>(null);
  }

  public getCurrentActiveLabel(deploymentKey: string, clientUniqueId: string): q.Promise<string> {
    return q<string>(null);
  }

  public updateActiveAppForClient(
    deploymentKey: string,
    clientUniqueId: string,
    toLabel: string,
    fromLabel?: string
  ): q.Promise<void> {
    return q<void>(null);
  }

  /**
   * Nothing to close -- there is no connection, only a fetch-based client. The
   * cache is dropped so a test that constructs several managers cannot leak one
   * into the next.
   */
  public close(): q.Promise<void> {
    this._cache.clear();
    return q<void>(null);
  }
}
