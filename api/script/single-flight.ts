// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//
// De-duplication of identical in-flight loads.
//
// WHY THIS EXISTS -- THE COLD-START STAMPEDE
// ------------------------------------------
// With Redis, the update_check response cache survived a process restart: the
// cache lived in a separate service, so a container that came back up found the
// fleet's answers already there. An IN-PROCESS cache (response-cache.ts) does
// not. Every restart -- an OOM kill, a `docker compose up -d`, the GHCR poller
// firing, a deploy -- starts with an empty cache, and every device whose next
// update check lands in the following seconds misses it. The whole fleet's
// misses then arrive at the database AT ONCE, on the one code path that must
// never be slow.
//
// Those misses are not different questions. Every device on a deployment asks
// `getPackageHistoryFromDeploymentKey(<same key>)`, so N concurrent misses are N
// copies of ONE query. This class collapses them: the first caller starts the
// load, everyone who asks for the same key while it is running attaches to the
// SAME promise, and the entry is removed as soon as it settles so the next
// request re-loads rather than being served a stale value. It is a stampede
// guard, NOT a cache -- nothing is retained after settlement.
//
// WHAT IT IS SAFE TO WRAP, AND WHAT IT IS NOT
// -------------------------------------------
// Callers share one resolved VALUE. That is only sound when the loader is a
// pure read whose result nobody mutates:
//
//   * SAFE, and the reason this exists: `storage.getPackageHistoryFromDeploymentKey`.
//     `utils/acquisition.ts:getUpdatePackage` only READS the history array -- it
//     builds a fresh `updateDetails` object per call and never writes to a
//     `Package` -- and `routes/acquisition.ts` mutates only that fresh object
//     (`updateInfo.target_binary_range`) and the per-request response body.
//   * NOT SAFE: anything that writes to `res`. `createResponseUsingStorage`
//     sends the malformed-request errors itself, so sharing a call to IT across
//     requests would answer the first caller and leave the rest hanging until
//     REQUEST_TIMEOUT_IN_MILLISECONDS. That is why the wrap sits around the
//     storage read INSIDE it, not around the whole function.
//
// Rejections are shared too, which is correct: every waiter was going to run the
// same failing query. Each waiter attaches its own handlers to the returned
// promise, so each gets its own error path.
//

import * as q from "q";

export class SingleFlight {
  // `q.Promise<unknown>` rather than a per-key generic: a Map cannot be typed
  // heterogeneously, and the cast on the way out is checked by the call site's
  // own loader signature. Deliberately NOT `any` -- `unknown` forces the cast to
  // be written where a reviewer can see it.
  private _inFlight: Map<string, q.Promise<unknown>> = new Map<string, q.Promise<unknown>>();

  /**
   * Run `loader` for `key`, or attach to the run already in progress for it.
   */
  public run<T>(key: string, loader: () => q.Promise<T>): q.Promise<T> {
    const existing: q.Promise<unknown> = this._inFlight.get(key);
    if (existing) {
      return <q.Promise<T>>(<unknown>existing);
    }

    let pending: q.Promise<T>;
    try {
      pending = loader();
    } catch (loaderError) {
      // A loader that throws SYNCHRONOUSLY must not leave a poisoned entry in
      // the map -- nothing was registered yet, so just surface it.
      return q.reject<T>(loaderError);
    }

    this._inFlight.set(key, pending);

    // Identity check before deleting: if this entry has already been replaced by
    // a later run for the same key, the later one owns the slot.
    const release = (): void => {
      if (this._inFlight.get(key) === pending) {
        this._inFlight.delete(key);
      }
    };

    // Both arms, so a rejection releases the slot too. This derived promise
    // handles the rejection (the handler returns normally), so it does not
    // become an unhandled rejection of its own; the ORIGINAL promise is what is
    // returned to callers, and each of them attaches their own handlers.
    pending.then(release, release);

    return pending;
  }

  /** Number of loads currently in flight. For tests and diagnostics. */
  public size(): number {
    return this._inFlight.size;
  }
}
