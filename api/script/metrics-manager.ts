// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//
// The seam that lets this server run its response cache and its deployment
// metrics on something other than Azure Redis.
//
// `RedisManager` was referenced by CLASS in both routers (`AcquisitionConfig`
// and `ManagementConfig`), and a class with private fields is not structurally
// substitutable in TypeScript -- so no alternative implementation could be
// passed in, however identical its public surface. `MetricsManager` below is
// exactly that public surface, extracted verbatim: same method names, same
// argument lists, same `q.Promise` return types, same `isEnabled` semantics.
// `RedisManager` satisfies it without modification (it is never edited by this
// change), and so does `SupabaseMetricsManager`.
//
// THE SWITCH, AND WHY IT DEFAULTS TO REDIS
// ----------------------------------------
// The cutover to LazyWait's own stack runs as TWO flips, and this variable
// belongs to the second one:
//
//   FLIP A -- network only. The container moves to the VPS, the Azure App
//     Service is demoted to a proxy, and the process still runs against the
//     Azure table, the Azure blobs AND the Azure Redis instance. Nothing in
//     this file is set; `createMetricsManager()` returns a `RedisManager`,
//     which is today's behaviour to the byte.
//   FLIP B -- data only. `CODEPUSH_STORAGE_BACKEND=supabase` and
//     `CODEPUSH_METRICS_BACKEND=supabase` are set together. Reverting is
//     un-setting both and restarting.
//
// The two variables are deliberately INDEPENDENT rather than one switch: the
// metrics move writes into `codepush_deployment_metric`, which only exists once
// migration 803 has been applied, and the storage move needs the same schema for
// a much larger surface. Being able to flip one at a time is what makes a
// partial rollback possible at all.
//
// A value other than "supabase" -- including unset, empty, or a typo -- yields
// the Redis manager. A silent fallback is the right failure mode here ONLY
// because the Redis path is the incumbent; the Supabase manager, once selected,
// fails loudly if it cannot reach its schema.
//

import { CacheableResponse, DeploymentMetrics, RedisManager } from "./redis-manager";
import { SupabaseMetricsManager } from "./supabase-metrics-manager";

import * as q from "q";

export const ENV_METRICS_BACKEND = "CODEPUSH_METRICS_BACKEND";
export const METRICS_BACKEND_SUPABASE = "supabase";

/**
 * The public surface of `RedisManager`, extracted so it can have more than one
 * implementation. Every member below exists because a route calls it; nothing
 * has been added, and nothing has been dropped.
 *
 * `isEnabled` is load-bearing in TWO places and must stay meaningful:
 *   * `routes/management.ts:1042` short-circuits the deployment metrics endpoint
 *     to `{ metrics: {} }` when it is false -- which is what the ERP CodePush
 *     page renders;
 *   * `routes/acquisition.ts` `/health` only probes `checkHealth()` when it is
 *     true, and reports "Healthy (no cache configured)" when it is not.
 * An implementation that hard-codes it to `true` while its backing store is
 * unreachable turns the first into a 500 and the second into a lie.
 */
export interface MetricsManager {
  readonly isEnabled: boolean;

  checkHealth(): q.Promise<void>;

  getCachedResponse(expiryKey: string, url: string): q.Promise<CacheableResponse>;
  setCachedResponse(expiryKey: string, url: string, response: CacheableResponse): q.Promise<void>;
  invalidateCache(expiryKey: string): q.Promise<void>;

  incrementLabelStatusCount(deploymentKey: string, label: string, status: string): q.Promise<void>;
  clearMetricsForDeploymentKey(deploymentKey: string): q.Promise<void>;
  getMetricsWithDeploymentKey(deploymentKey: string): q.Promise<DeploymentMetrics>;
  recordUpdate(
    currentDeploymentKey: string,
    currentLabel: string,
    previousDeploymentKey?: string,
    previousLabel?: string
  ): q.Promise<void>;

  // Deprecated in the upstream fork, still reachable. See the no-op note in
  // supabase-metrics-manager.ts -- do NOT delete these from the interface.
  removeDeploymentKeyClientActiveLabel(deploymentKey: string, clientUniqueId: string): q.Promise<void>;
  getCurrentActiveLabel(deploymentKey: string, clientUniqueId: string): q.Promise<string>;
  updateActiveAppForClient(deploymentKey: string, clientUniqueId: string, toLabel: string, fromLabel?: string): q.Promise<void>;

  close(): q.Promise<void>;
}

/**
 * Pick the manager for this process. Called once, at boot, from
 * `default-server.ts`.
 */
export function createMetricsManager(): MetricsManager {
  if (process.env[ENV_METRICS_BACKEND] === METRICS_BACKEND_SUPABASE) {
    return new SupabaseMetricsManager();
  }

  return new RedisManager();
}
