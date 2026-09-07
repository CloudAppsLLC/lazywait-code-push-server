// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//
// The in-process replacement for the Redis response cache.
//
// WHAT IT REPLACES
// ----------------
// `RedisManager` kept update_check answers in a Redis HASH per deployment key:
// `hset(deploymentKey:<key>, <url>, <json>)` with a one-hour `expire` set once,
// when the hash is FIRST created (redis-manager.ts:170-190). `del(<hash>)` is
// how a release becomes visible before that hour is up. This class reproduces
// exactly that shape -- a bucket per deployment key, an absolute (never
// sliding) TTL on the bucket, whole-bucket invalidation -- in this process's
// own memory, so the Azure Redis Cache line (~SR385/month at full-month run
// rate) can be switched off.
//
// TWO PROPERTIES ARE DELIBERATE AND NOT NEGOTIABLE:
//
// 1. IT STORES JSON TEXT, NOT OBJECTS.
//    Redis serialised on write and `JSON.parse`d on read, so every caller got a
//    private copy. A Map of objects does NOT: `routes/acquisition.ts` takes a
//    REFERENCE into the cached body (`cachedResponseObject.originalPackage`)
//    and writes `updateInfo.target_binary_range` onto it before sending. Handing
//    out the stored object would let one request mutate the answer every other
//    device is about to receive -- a class of bug that simply cannot exist in
//    the Redis version. Serialising also makes the memory bound below
//    measurable in bytes instead of in "objects of unknown depth".
//
// 2. IT IS BOUNDED ON BOTH AXES -- AGE AND SIZE.
//    Redis enforced age (`expire`) and size (`maxmemory` on the instance) for
//    us. In-process, an unbounded Map in a container that is meant to run for
//    weeks is a memory leak with a slow fuse: the process grows until the OOM
//    killer takes it, which also empties the cache, which sends the whole fleet
//    at the database at once (see the cold-start note in
//    supabase-metrics-manager.ts). So: an absolute TTL per bucket, a hard cap on
//    entry COUNT and a hard cap on total BYTES, with oldest-first eviction and a
//    small amortised sweep of expired buckets on every write.
//
// The eviction order is the insertion (or re-write) order of the entry, which
// the Map iterator gives us for free. Because every bucket carries the same
// fixed TTL, insertion order and expiry order agree closely enough that a
// separate age-ordered structure would buy nothing.
//

import { CacheableResponse } from "./redis-manager";

// One hour, matching RedisManager.DEFAULT_EXPIRY (redis-manager.ts:91) exactly.
// This is the ONLY thing bounding how stale an answer can be on a replica that
// missed an invalidation, so it is a safety property, not a tuning knob.
export const DEFAULT_RESPONSE_CACHE_TTL_MS: number = 60 * 60 * 1000;

// The key space is (route, deployment key, app version, package hash, label,
// is_companion) once `getUrlKey` strips BOTH spellings of the client id
// (routes/acquisition.ts) -- a few hundred entries for the whole fleet. 20k is
// therefore ~2 orders of magnitude of headroom, and the byte cap is the one
// that will actually bite if a client ever starts sending an unbounded
// parameter.
export const DEFAULT_RESPONSE_CACHE_MAX_ENTRIES: number = 20000;
export const DEFAULT_RESPONSE_CACHE_MAX_BYTES: number = 32 * 1024 * 1024;

// How many of the oldest entries to examine for an expired bucket on each
// write. Amortised: a steady-state cache sweeps itself clean without ever
// walking the whole Map, and a cache nobody writes to holds at most its cap.
const EXPIRED_SWEEP_BUDGET: number = 8;

// U+0000 cannot appear in a URL or in a deployment key, so a flat key built
// with it can never be forged by concatenation.
const KEY_SEPARATOR: string = "\u0000";

export interface ResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  // Injectable clock. Tests need to cross the TTL boundary without sleeping for
  // an hour; production never passes this.
  now?: () => number;
}

export interface ResponseCacheStats {
  entries: number;
  buckets: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

interface Bucket {
  // ABSOLUTE, set when the bucket is created and never extended. Redis only
  // calls `expire` when the hash did not already exist (redis-manager.ts:
  // 184-188), so a busy deployment key does not keep its answers alive forever.
  // A sliding TTL here would mean the most-requested deployment -- the one in
  // the middle of a rollout -- is exactly the one whose stale answer never ages
  // out.
  expiresAt: number;
  urls: Set<string>;
}

interface Entry {
  bucketKey: string;
  url: string;
  serialized: string;
  bytes: number;
}

export class ResponseCache {
  private _ttlMs: number;
  private _maxEntries: number;
  private _maxBytes: number;
  private _now: () => number;

  private _buckets: Map<string, Bucket> = new Map<string, Bucket>();
  // Insertion-ordered: the first key the iterator yields is the oldest write,
  // which is what eviction removes.
  private _entries: Map<string, Entry> = new Map<string, Entry>();
  private _bytes: number = 0;

  private _hits: number = 0;
  private _misses: number = 0;
  private _evictions: number = 0;
  private _expirations: number = 0;

  public constructor(options?: ResponseCacheOptions) {
    const resolved: ResponseCacheOptions = options || {};
    this._ttlMs = resolved.ttlMs > 0 ? resolved.ttlMs : DEFAULT_RESPONSE_CACHE_TTL_MS;
    this._maxEntries = resolved.maxEntries > 0 ? resolved.maxEntries : DEFAULT_RESPONSE_CACHE_MAX_ENTRIES;
    this._maxBytes = resolved.maxBytes > 0 ? resolved.maxBytes : DEFAULT_RESPONSE_CACHE_MAX_BYTES;
    this._now = resolved.now || (() => Date.now());
  }

  public get(bucketKey: string, url: string): CacheableResponse {
    const bucket: Bucket = this._buckets.get(bucketKey);
    if (!bucket) {
      this._misses++;
      return null;
    }

    if (this._now() >= bucket.expiresAt) {
      // Age eviction happens on READ as well as on write: a deployment that
      // goes quiet must not keep an hour-old answer resident until write
      // pressure happens to reach it.
      this.dropBucket(bucketKey);
      this._expirations++;
      this._misses++;
      return null;
    }

    const flat: string = ResponseCache.flatKey(bucketKey, url);
    const entry: Entry = this._entries.get(flat);
    if (!entry) {
      this._misses++;
      return null;
    }

    let parsed: CacheableResponse;
    try {
      parsed = <CacheableResponse>JSON.parse(entry.serialized);
    } catch (parseError) {
      // Unreachable unless the string was corrupted in memory, but a cache that
      // throws on read would take update checks for one deployment key down
      // until the hour was out. Treat it as a miss and drop the entry.
      this.removeEntry(flat);
      this._misses++;
      return null;
    }

    this._hits++;
    return parsed;
  }

  public set(bucketKey: string, url: string, response: CacheableResponse): void {
    this.sweepExpired();

    const now: number = this._now();
    let bucket: Bucket = this._buckets.get(bucketKey);
    if (bucket && now >= bucket.expiresAt) {
      this.dropBucket(bucketKey);
      this._expirations++;
      bucket = undefined;
    }

    if (!bucket) {
      bucket = { expiresAt: now + this._ttlMs, urls: new Set<string>() };
      this._buckets.set(bucketKey, bucket);
    }

    const serialized: string = JSON.stringify(response);
    const flat: string = ResponseCache.flatKey(bucketKey, url);

    // Delete-then-set so a rewrite moves the entry to the YOUNG end of the
    // eviction order. Without it a hot entry refreshed every minute would still
    // be evicted first, which is the opposite of what we want.
    this.removeEntry(flat);

    const entry: Entry = { bucketKey: bucketKey, url: url, serialized: serialized, bytes: ResponseCache.sizeOf(flat, serialized) };
    this._entries.set(flat, entry);
    this._bytes += entry.bytes;
    bucket.urls.add(url);

    this.enforceBounds(flat);
  }

  /**
   * Whole-bucket invalidation -- the `del(deploymentKey:<key>)` in
   * `RedisManager.invalidateCache`, and the ONLY mechanism that makes a release
   * visible to the fleet before the TTL expires.
   */
  public invalidate(bucketKey: string): void {
    this.dropBucket(bucketKey);
  }

  public clear(): void {
    this._buckets.clear();
    this._entries.clear();
    this._bytes = 0;
  }

  public stats(): ResponseCacheStats {
    return {
      entries: this._entries.size,
      buckets: this._buckets.size,
      bytes: this._bytes,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      expirations: this._expirations,
    };
  }

  // -- internals -------------------------------------------------------------

  private static flatKey(bucketKey: string, url: string): string {
    return bucketKey + KEY_SEPARATOR + url;
  }

  // Two bytes per UTF-16 code unit plus a fixed allowance for the Map entry,
  // the Set member and the object header. Deliberately an OVER-estimate: the
  // point of the byte cap is to stop the process being OOM-killed, and a cap
  // that under-counts its own bookkeeping does not do that.
  private static sizeOf(flat: string, serialized: string): number {
    return (flat.length + serialized.length) * 2 + 128;
  }

  private removeEntry(flat: string): void {
    const existing: Entry = this._entries.get(flat);
    if (!existing) {
      return;
    }

    this._entries.delete(flat);
    this._bytes -= existing.bytes;

    const bucket: Bucket = this._buckets.get(existing.bucketKey);
    if (bucket) {
      bucket.urls.delete(existing.url);
      if (bucket.urls.size === 0) {
        this._buckets.delete(existing.bucketKey);
      }
    }
  }

  private dropBucket(bucketKey: string): void {
    const bucket: Bucket = this._buckets.get(bucketKey);
    if (!bucket) {
      return;
    }

    bucket.urls.forEach((url: string) => {
      const flat: string = ResponseCache.flatKey(bucketKey, url);
      const existing: Entry = this._entries.get(flat);
      if (existing) {
        this._entries.delete(flat);
        this._bytes -= existing.bytes;
      }
    });

    this._buckets.delete(bucketKey);
  }

  /**
   * Evict oldest-first until both caps hold. `keepFlat` is the entry written by
   * the call that triggered this: with a pathologically small cap it would
   * otherwise be possible to evict the entry we just inserted and report a
   * store that silently did nothing.
   */
  private enforceBounds(keepFlat: string): void {
    while ((this._entries.size > this._maxEntries || this._bytes > this._maxBytes) && this._entries.size > 1) {
      const oldest: string = this._entries.keys().next().value;
      if (oldest === undefined || oldest === keepFlat) {
        // The just-written entry is the oldest only when it is the only one
        // left, which the loop guard already excludes -- so reaching this means
        // the caps are set below one entry. Stop rather than spin.
        return;
      }

      this.removeEntry(oldest);
      this._evictions++;
    }
  }

  /**
   * Look at a fixed number of the oldest entries and drop the ones whose bucket
   * has expired. Bounded work per write, so a cache under load pays a constant,
   * and a cache that is only written to occasionally still cleans itself.
   */
  private sweepExpired(): void {
    const now: number = this._now();
    const candidates: string[] = [];

    const iterator: Iterator<Entry> = this._entries.values();
    for (let index = 0; index < EXPIRED_SWEEP_BUDGET; index++) {
      const step: IteratorResult<Entry> = iterator.next();
      if (step.done) {
        break;
      }

      const bucket: Bucket = this._buckets.get(step.value.bucketKey);
      if (!bucket || now >= bucket.expiresAt) {
        candidates.push(step.value.bucketKey);
      }
    }

    candidates.forEach((bucketKey: string) => {
      if (this._buckets.has(bucketKey)) {
        this.dropBucket(bucketKey);
        this._expirations++;
      }
    });
  }
}
