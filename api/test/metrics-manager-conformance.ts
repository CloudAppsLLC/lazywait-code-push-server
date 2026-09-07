// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// =============================================================================
// CACHE + METRICS MANAGER CONFORMANCE  --  the Redis replacement
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// `SupabaseMetricsManager` takes over two jobs that Azure Redis did: the
// update_check response cache and the deployment metric counters. Both fail
// SILENTLY when they are wrong -- a stale cache answers HTTP 200 with
// `is_available:false`, and a mis-keyed metric write produces a number on the
// ERP CodePush page that is simply not true and cannot be re-derived (status
// reports are fire-and-forget; there is no second copy anywhere). Neither shows
// up in a log.
//
// So this harness pins the handful of properties that make the replacement
// equivalent to Redis, and the one property that makes it BETTER than a naive
// Map (bounded memory). It needs no database and no network: the Postgres write
// path is exercised through the `MetricSink` seam with an in-memory recorder,
// which is deliberate -- what has to be asserted is the ENTRY ARRAY the manager
// builds, and that is a pure function of the arguments.
//
// THE SINGLE MOST IMPORTANT CHECK IN HERE
// ---------------------------------------
// "recordUpdate after a promote writes to BOTH deployments." `recordUpdate`
// increments Active + DeploymentSucceeded on the CURRENT deployment key and
// DECREMENTS Active on the PREVIOUS one, and the previous key comes off the
// request body. After a Staging -> Production promote those are two different
// deployments. Any implementation that assumes one key -- which is the obvious
// way to write this RPC -- silently leaves Staging's Active count carrying
// every device that ever moved to Production, forever. `codepush_bump_metrics`
// takes a JSONB ARRAY precisely so that cannot happen; this file is what proves
// the caller uses it that way.
//
// HOW TO RUN
//   cd api && npm run test:conformance      (storage-conformance.ts runs these too)
//   cd api && npx tsc && node ./bin/test/metrics-manager-conformance.js
// =============================================================================

import * as assert from "assert";

import * as converterUtils from "../script/utils/converter";
import { ACTIVE, DEPLOYMENT_FAILED, DEPLOYMENT_SUCCEEDED, DOWNLOADED, CacheableResponse } from "../script/redis-manager";
import { MetricEntry, MetricSink, SupabaseMetricsManager } from "../script/supabase-metrics-manager";
import { ResponseCache } from "../script/response-cache";
import { SingleFlight } from "../script/single-flight";

import * as q from "q";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface MetricRow {
  label: string;
  status: string;
  count: number | string;
}

/**
 * Records every call the manager makes. `bump` keeps the CALLS, not a flattened
 * list of entries: "three entries in one call" and "three calls of one entry"
 * are different behaviours -- the first is one transaction, the second is three
 * -- and the multi-key check below is about the first.
 */
class RecordingSink implements MetricSink {
  public bumps: MetricEntry[][] = [];
  public reads: string[] = [];
  public clears: string[] = [];
  public checks: number = 0;
  public rows: MetricRow[] = [];
  public checkError: Error = null;

  public async bump(entries: MetricEntry[]): Promise<void> {
    // Copy: the manager owns the array it passed and a later mutation must not
    // rewrite history in the recording.
    this.bumps.push(entries.map((entry: MetricEntry) => Object.assign({}, entry)));
  }

  public async read(deploymentKey: string): Promise<MetricRow[]> {
    this.reads.push(deploymentKey);
    return this.rows;
  }

  public async clear(deploymentKey: string): Promise<void> {
    this.clears.push(deploymentKey);
  }

  public async check(): Promise<void> {
    this.checks++;
    if (this.checkError) {
      throw this.checkError;
    }
  }
}

// A movable clock so the one-hour TTL can be crossed without waiting an hour.
class TestClock {
  private _now: number = 1_700_000_000_000;

  public now = (): number => this._now;

  public advance(ms: number): void {
    this._now += ms;
  }
}

const DEPLOYMENT_KEY = "deploymentKey:conformance-key";
const PROMOTED_FROM_KEY = "deploymentKey:conformance-staging-key";
const URL_A = "/updateCheck?deployment_key=k&app_version=1.0.0";
const URL_B = "/updateCheck?deployment_key=k&app_version=2.0.0";

function response(label: string): CacheableResponse {
  return {
    statusCode: 200,
    body: { originalPackage: { label: label, isAvailable: true, appVersion: "1.0.0" } },
  };
}

function toNative<T>(promise: { then: (onOk: (value: T) => void, onErr: (reason: unknown) => void) => unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    promise.then(resolve, reject);
  });
}

// ---------------------------------------------------------------------------
// The checks. Shared by the mocha tree and the standalone runner, exactly as in
// storage-conformance.ts.
// ---------------------------------------------------------------------------

export interface MetricsManagerCheck {
  name: string;
  run: () => Promise<void>;
}

export const METRICS_MANAGER_CHECKS: MetricsManagerCheck[] = [
  {
    name: "cache: a cold key is a miss, a written key is a hit",
    run: async () => {
      const manager = new SupabaseMetricsManager({ sink: null });

      assert.strictEqual(
        await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A)),
        null,
        "cold read must be null, not undefined"
      );

      await toNative(manager.setCachedResponse(DEPLOYMENT_KEY, URL_A, response("v3")));

      assert.deepStrictEqual(await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A)), response("v3"));
    },
  },
  {
    name: "cache: a hit hands out a COPY, not the stored object",
    run: async () => {
      // Redis serialised on write and parsed on read, so no two requests ever
      // shared an object. routes/acquisition.ts writes
      // `updateInfo.target_binary_range` onto whatever it gets back; if that is
      // the stored object, one request mutates the answer every other device is
      // about to receive.
      const manager = new SupabaseMetricsManager({ sink: null });
      await toNative(manager.setCachedResponse(DEPLOYMENT_KEY, URL_A, response("v3")));

      const first = await toNative<CacheableResponse>(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A));
      (<{ [key: string]: unknown }>first.body).target_binary_range = "tampered";
      first.statusCode = 500;

      const second = await toNative<CacheableResponse>(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A));
      assert.deepStrictEqual(second, response("v3"), "a mutation of one caller's copy leaked into the cache");
    },
  },
  {
    name: "cache: entries are keyed by url within a deployment-key bucket",
    run: async () => {
      const manager = new SupabaseMetricsManager({ sink: null });
      await toNative(manager.setCachedResponse(DEPLOYMENT_KEY, URL_A, response("v3")));

      assert.strictEqual(await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_B)), null);
      assert.deepStrictEqual(await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A)), response("v3"));
    },
  },
  {
    name: "cache: invalidateCache drops the WHOLE bucket (the release-visibility path)",
    run: async () => {
      // management.ts calls this after every release/promote/rollback/patch. It
      // is the only thing that makes a new release visible before the TTL, so
      // "drops one url" would be a fleet-visible bug.
      const manager = new SupabaseMetricsManager({ sink: null });
      await toNative(manager.setCachedResponse(DEPLOYMENT_KEY, URL_A, response("v3")));
      await toNative(manager.setCachedResponse(DEPLOYMENT_KEY, URL_B, response("v3")));
      await toNative(manager.setCachedResponse(PROMOTED_FROM_KEY, URL_A, response("v9")));

      await toNative(manager.invalidateCache(DEPLOYMENT_KEY));

      assert.strictEqual(await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A)), null);
      assert.strictEqual(await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_B)), null);
      assert.deepStrictEqual(
        await toNative(manager.getCachedResponse(PROMOTED_FROM_KEY, URL_A)),
        response("v9"),
        "invalidating one deployment key must not touch another"
      );
    },
  },
  {
    name: "cache: the TTL is ABSOLUTE and one hour, not sliding",
    run: async () => {
      const clock = new TestClock();
      const cache = new ResponseCache({ now: clock.now });

      cache.set(DEPLOYMENT_KEY, URL_A, response("v3"));
      clock.advance(59 * 60 * 1000);
      assert.ok(cache.get(DEPLOYMENT_KEY, URL_A), "must still be live at +59 minutes");

      // A LATER write into the same bucket must not extend the bucket's life:
      // Redis only calls `expire` when the hash did not already exist, so the
      // busiest deployment key -- the one mid-rollout -- would otherwise be the
      // one whose stale answers never age out.
      cache.set(DEPLOYMENT_KEY, URL_B, response("v3"));
      clock.advance(2 * 60 * 1000);

      assert.strictEqual(cache.get(DEPLOYMENT_KEY, URL_A), null, "must be expired at +61 minutes");
      assert.strictEqual(cache.get(DEPLOYMENT_KEY, URL_B), null, "a later write must not have extended the bucket TTL");
    },
  },
  {
    name: "cache: bounded by entry COUNT, oldest first",
    run: async () => {
      const cache = new ResponseCache({ maxEntries: 3 });

      for (let index = 0; index < 5; index++) {
        cache.set(DEPLOYMENT_KEY, `${URL_A}&n=${index}`, response(`v${index}`));
      }

      const stats = cache.stats();
      assert.strictEqual(stats.entries, 3, "the cap must hold");
      assert.ok(stats.evictions >= 2, "eviction must have happened, not silent growth");
      assert.strictEqual(cache.get(DEPLOYMENT_KEY, `${URL_A}&n=0`), null, "the oldest entry must be the one evicted");
      assert.ok(cache.get(DEPLOYMENT_KEY, `${URL_A}&n=4`), "the newest entry must survive");
    },
  },
  {
    name: "cache: bounded by BYTES as well as by count",
    run: async () => {
      // An entry cap alone does not bound memory: one pathological response is
      // enough to blow the container's limit, and an OOM kill is also a cache
      // flush and therefore a fleet-wide stampede.
      const cache = new ResponseCache({ maxEntries: 1000, maxBytes: 4096 });

      for (let index = 0; index < 40; index++) {
        cache.set(DEPLOYMENT_KEY, `${URL_A}&n=${index}`, response(`v${index}`));
      }

      const stats = cache.stats();
      assert.ok(stats.bytes <= 4096, `byte cap must hold, saw ${stats.bytes}`);
      assert.ok(stats.entries < 40, "entries must have been evicted to hold the byte cap");
    },
  },
  {
    name: "cache: still works when metrics are unavailable (isEnabled === false)",
    run: async () => {
      // The two are independent here in a way they were not under Redis, where
      // one instance backed both. A deployment with no database must still
      // cache; a deployment with no cache is not a thing this class can produce.
      const manager = new SupabaseMetricsManager({ sink: null });

      assert.strictEqual(manager.isEnabled, false, "isEnabled reports METRICS availability");
      await toNative(manager.setCachedResponse(DEPLOYMENT_KEY, URL_A, response("v3")));
      assert.deepStrictEqual(await toNative(manager.getCachedResponse(DEPLOYMENT_KEY, URL_A)), response("v3"));
    },
  },
  {
    name: "metrics: incrementLabelStatusCount writes ONE +1 entry",
    run: async () => {
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      await toNative(manager.incrementLabelStatusCount(DEPLOYMENT_KEY, "v7", DOWNLOADED));

      assert.deepStrictEqual(sink.bumps, [[{ deployment_key: DEPLOYMENT_KEY, label: "v7", status: DOWNLOADED, delta: 1 }]]);
    },
  },
  {
    name: "metrics: an invalid status is dropped, not written as a row",
    run: async () => {
      // Redis wrote a field literally named "null" for these (getLabelStatusField
      // returns null outside the three valid statuses). In a table with a primary
      // key that is a permanent junk row on a hot path.
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      await toNative(manager.incrementLabelStatusCount(DEPLOYMENT_KEY, "v7", "NotAStatus"));

      assert.deepStrictEqual(sink.bumps, [], "an invalid status must not reach the database");
    },
  },
  {
    name: "metrics: recordUpdate on one deployment writes Active + DeploymentSucceeded in ONE call",
    run: async () => {
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      await toNative(manager.recordUpdate(DEPLOYMENT_KEY, "v7", DEPLOYMENT_KEY, "v6"));

      assert.strictEqual(sink.bumps.length, 1, "must be one RPC call, i.e. one transaction");
      assert.deepStrictEqual(sink.bumps[0], [
        { deployment_key: DEPLOYMENT_KEY, label: "v7", status: ACTIVE, delta: 1 },
        { deployment_key: DEPLOYMENT_KEY, label: "v7", status: DEPLOYMENT_SUCCEEDED, delta: 1 },
        { deployment_key: DEPLOYMENT_KEY, label: "v6", status: ACTIVE, delta: -1 },
      ]);
    },
  },
  {
    name: "metrics: recordUpdate AFTER A PROMOTE decrements the OTHER deployment (multi-key)",
    run: async () => {
      // THE check this file exists for. The device moved from Staging to
      // Production, so `previousDeploymentKey` is a different deployment. A
      // single-key RPC applies the -1 Active to Production instead of Staging,
      // and Staging over-reports Active by one device per promotion, forever.
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      await toNative(manager.recordUpdate(DEPLOYMENT_KEY, "v1", PROMOTED_FROM_KEY, "v9"));

      assert.strictEqual(sink.bumps.length, 1, "both deployments must be bumped in ONE call");

      const entries: MetricEntry[] = sink.bumps[0];
      const keys: string[] = entries.map((entry: MetricEntry) => entry.deployment_key);
      assert.ok(keys.indexOf(PROMOTED_FROM_KEY) !== -1, "the PREVIOUS deployment key must appear in the entry array");

      const decrements = entries.filter((entry: MetricEntry) => entry.delta < 0);
      assert.deepStrictEqual(
        decrements,
        [{ deployment_key: PROMOTED_FROM_KEY, label: "v9", status: ACTIVE, delta: -1 }],
        "the -1 Active must land on the previous deployment key and its label"
      );

      const increments = entries.filter((entry: MetricEntry) => entry.delta > 0);
      assert.deepStrictEqual(
        increments.map((entry: MetricEntry) => `${entry.deployment_key}|${entry.label}|${entry.status}`),
        [`${DEPLOYMENT_KEY}|v1|${ACTIVE}`, `${DEPLOYMENT_KEY}|v1|${DEPLOYMENT_SUCCEEDED}`]
      );
    },
  },
  {
    name: "metrics: recordUpdate with no previous label writes only the two increments",
    run: async () => {
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      await toNative(manager.recordUpdate(DEPLOYMENT_KEY, "v1", DEPLOYMENT_KEY, undefined));

      assert.strictEqual(sink.bumps[0].length, 2, "no previous label means no decrement");
    },
  },
  {
    name: "metrics: the read shape is 'label:status' and survives converter.toRestDeploymentMetrics",
    run: async () => {
      // utils/converter.ts:toRestDeploymentMetrics is UNCHANGED by this
      // migration -- it splits on ":" and is what the CLI and the ERP CodePush
      // page render. This asserts the manager's re-keying against that consumer
      // rather than against itself.
      const sink = new RecordingSink();
      sink.rows = [
        { label: "v1", status: ACTIVE, count: 123 },
        { label: "v1", status: DEPLOYMENT_SUCCEEDED, count: 130 },
        { label: "v1", status: DEPLOYMENT_FAILED, count: 4 },
        // BIGINT can arrive as a string depending on the serialiser; converter
        // does `+=` on these, so a string would concatenate into "0123".
        { label: "v1", status: DOWNLOADED, count: "140" },
      ];
      const manager = new SupabaseMetricsManager({ sink: sink });

      const metrics = await toNative<{ [labelStatus: string]: number }>(manager.getMetricsWithDeploymentKey(DEPLOYMENT_KEY));

      assert.deepStrictEqual(sink.reads, [DEPLOYMENT_KEY], "must be a single read for the deployment key");
      assert.deepStrictEqual(metrics, {
        [`v1:${ACTIVE}`]: 123,
        [`v1:${DEPLOYMENT_SUCCEEDED}`]: 130,
        [`v1:${DEPLOYMENT_FAILED}`]: 4,
        [`v1:${DOWNLOADED}`]: 140,
      });

      assert.deepStrictEqual(converterUtils.toRestDeploymentMetrics(metrics), {
        v1: { active: 123, downloaded: 140, failed: 4, installed: 130 },
      });
    },
  },
  {
    name: "metrics: an unknown deployment key reads as empty, not as an error",
    run: async () => {
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      const metrics = await toNative(manager.getMetricsWithDeploymentKey("deploymentKey:never-existed"));

      assert.deepStrictEqual(metrics, {});
      assert.deepStrictEqual(converterUtils.toRestDeploymentMetrics(metrics), {});
    },
  },
  {
    name: "metrics: clearMetricsForDeploymentKey deletes by key",
    run: async () => {
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      await toNative(manager.clearMetricsForDeploymentKey(DEPLOYMENT_KEY));

      assert.deepStrictEqual(sink.clears, [DEPLOYMENT_KEY]);
    },
  },
  {
    name: "checkHealth RESOLVES when there is nothing to check",
    run: async () => {
      // RedisManager rejects here when it is not configured, which made /health
      // a permanent 500 -- and therefore the container permanently unhealthy --
      // on a deployment with no cache. Do not reintroduce that shape.
      const manager = new SupabaseMetricsManager({ sink: null });

      await toNative(manager.checkHealth());
    },
  },
  {
    name: "checkHealth REJECTS when the metrics backend is configured but broken",
    run: async () => {
      // Configured-but-unreachable is a real fault and must fail the probe;
      // only "not configured" is allowed to pass quietly.
      const sink = new RecordingSink();
      sink.checkError = new Error('relation "codepush_deployment_metric" does not exist');
      const manager = new SupabaseMetricsManager({ sink: sink });

      let rejected = false;
      try {
        await toNative(manager.checkHealth());
      } catch (reason) {
        rejected = true;
      }

      assert.strictEqual(rejected, true, "a broken metrics backend must fail the health probe");
      assert.strictEqual(sink.checks, 1);
    },
  },
  {
    name: "the deprecated per-client methods EXIST and resolve as no-ops",
    run: async () => {
      // removeDeploymentKeyClientActiveLabel is called on the MODERN path, after
      // res.sendStatus(200). A missing method there is a post-response
      // TypeError swallowed by express-domain-middleware into a response whose
      // send() is already a no-op: completely invisible. The methods stay.
      const sink = new RecordingSink();
      const manager = new SupabaseMetricsManager({ sink: sink });

      assert.strictEqual(typeof manager.removeDeploymentKeyClientActiveLabel, "function");
      assert.strictEqual(typeof manager.updateActiveAppForClient, "function");
      assert.strictEqual(typeof manager.getCurrentActiveLabel, "function");

      await toNative(manager.removeDeploymentKeyClientActiveLabel(DEPLOYMENT_KEY, "device-1"));
      await toNative(manager.updateActiveAppForClient(DEPLOYMENT_KEY, "device-1", "v7", "v6"));
      assert.strictEqual(await toNative(manager.getCurrentActiveLabel(DEPLOYMENT_KEY, "device-1")), null);

      assert.deepStrictEqual(sink.bumps, [], "the per-client hash is not reproduced in Postgres");
    },
  },
  {
    name: "single-flight: N concurrent identical misses cost ONE load",
    run: async () => {
      // The cold-start stampede guard. Every container restart empties the
      // in-process cache and the whole fleet's next check arrives at once, all
      // asking getPackageHistoryFromDeploymentKey the same question.
      const flight = new SingleFlight();
      let loads = 0;
      const gate = q.defer<string>();

      const started = [0, 1, 2, 3, 4].map(() =>
        toNative<string>(
          flight.run("packageHistory:k", () => {
            loads++;
            return gate.promise;
          })
        )
      );

      assert.strictEqual(loads, 1, "five concurrent callers must produce one load");
      assert.strictEqual(flight.size(), 1);

      gate.resolve("history");
      const results = await Promise.all(started);

      assert.deepStrictEqual(results, ["history", "history", "history", "history", "history"]);
      assert.strictEqual(flight.size(), 0, "the entry must be released once it settles -- this is not a cache");
    },
  },
  {
    name: "single-flight: a settled load is not reused, and a rejection reaches every caller",
    run: async () => {
      const flight = new SingleFlight();
      let loads = 0;

      await toNative(
        flight.run("packageHistory:k", () => {
          loads++;
          return q("first");
        })
      );
      await toNative(
        flight.run("packageHistory:k", () => {
          loads++;
          return q("second");
        })
      );
      assert.strictEqual(loads, 2, "a completed load must not be served to the next request");

      const failing = q.defer<string>();
      const waiters = [0, 1].map(() => toNative<string>(flight.run("packageHistory:broken", () => failing.promise)));
      failing.reject(new Error("PostgREST is down"));

      const outcomes = await Promise.all(
        waiters.map((waiter: Promise<string>) =>
          waiter.then(
            () => "resolved",
            () => "rejected"
          )
        )
      );

      assert.deepStrictEqual(outcomes, ["rejected", "rejected"], "every waiter gets the failure, each on its own error path");
      assert.strictEqual(flight.size(), 0, "a failed load must release its slot too");
    },
  },
];

// ---------------------------------------------------------------------------
// Runners. Same dual shape as storage-conformance.ts: a mocha tree when mocha is
// present, a standalone runner when it is not (mocha is not a dependency of this
// fork today).
// ---------------------------------------------------------------------------

const SUITE_NAME = "Cache + metrics manager conformance (SupabaseMetricsManager)";

export async function runMetricsManagerChecks(log: (line: string) => void): Promise<number> {
  let failures = 0;

  for (const check of METRICS_MANAGER_CHECKS) {
    try {
      await check.run();
      log(`  ok   ${check.name}`);
    } catch (reason) {
      failures++;
      const message = reason instanceof Error ? reason.message : String(reason);
      log(`  FAIL ${check.name}`);
      log(`       ${message.split("\n").join("\n       ")}`);
    }
  }

  return failures;
}

if (typeof describe === "function" && typeof it === "function") {
  describe(SUITE_NAME, () => {
    METRICS_MANAGER_CHECKS.forEach((check) => {
      it(check.name, () => check.run());
    });
  });
} else if (require.main === module) {
  console.log(SUITE_NAME);
  runMetricsManagerChecks((line: string) => console.log(line)).then(
    (failures: number) => {
      console.log(`\n${failures === 0 ? "PASS" : "FAIL"} -- ${failures} failing check(s)`);
      process.exit(failures === 0 ? 0 : 1);
    },
    (reason: unknown) => {
      console.error(reason);
      process.exit(1);
    }
  );
}
