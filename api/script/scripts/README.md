# CodePush migration tooling — Azure ➜ Supabase

Operator scripts for moving this service off Azure: two that move data, two that prepare
and prove the target project.

| script | direction | writes to |
|---|---|---|
| `export-azure.ts` | Azure ➜ local JSON | nothing (READ-ONLY against Azure) |
| `import-supabase.ts` | local JSON ➜ Supabase | `codepush_*` tables + the `LazyWaitCodePush` bucket |
| `mint-codepush-jwt.ts` | — | nothing (mints + verifies the container's `codepush_api` JWT) |
| `verify-supabase-setup.ts` | — | nothing (READ-ONLY preflight; safe against production) |

Run the last two **before** the importer, and again before each flip:

```
yarn codepush:mint-jwt --expires 10y     # prints the token, and PROVES it against the project
yarn codepush:verify --strict            # 10 pass/fail lines: role, tables, RPCs, bucket, anon read, anon write
yarn test:tier1                          # the same preflight, then the storage conformance harness
```

`yarn test:tier1` refuses to run the harness when `SUPABASE_URL` equals
`CODEPUSH_PROD_SUPABASE_URL` — the harness writes rows. Set that variable in the shell you
use for cutover work and the guard is always armed. The full step-by-step, with rollbacks,
is [`deploy/RUNBOOK.md`](../../../deploy/RUNBOOK.md).

They are **not** part of the server. Nothing in `server.ts` requires them; they compile
into `bin/` with everything else and are run by hand.

---

## Why the export exists at all

Three things in the Azure account cannot be re-derived from anywhere in this repo or
any other:

1. **The `storagev2` table.** Nine row shapes in one table under a hand-rolled
   `"PartitionKey RowKey"` grammar (`storage/azure-storage.ts:24-140`). It is the only
   record of who owns which app, which token hash opens the management API, and which
   **deployment key** is compiled into which shipped binary.
2. **The `packagehistoryv1` blobs.** The release history, as a JSON blob per deployment.
   It is a rolling window of the last 50 entries trimmed from the *front*
   (`azure-storage.ts:739-740`) while labels keep counting up (`:1402-1410`) — so a
   deployment with 86 releases holds labels `v37…v86` in 50 slots. That asymmetry is the
   single most dangerous thing in this migration and both scripts are built around it.
3. **Redis DB 1.** The deployment metrics (`deploymentKeyLabels:<key>`).
   `grep -rn metric script/storage` returns **zero** hits: Redis is the only copy, and
   status reports are fire-and-forget. A lost counter is worse than a zeroed one —
   `recordUpdate` *decrements* the previous label (`redis-manager.ts:257-261`), so an
   empty `Active` counter drifts permanently negative once the fleet reports again.

**Run the export on a daily cron from today**, well before any cutover date. It costs
nothing and the Redis instance is the thing most likely to be deleted by accident.

## The dump is a SECRET. Treat it like one.

A run directory is not a backup you can leave lying around. `entities/deployment.json`
holds every **deployment key** in plaintext — the value compiled into shipped binaries,
which is the capability that lets its holder publish code to that channel — and
`entities/access_key.json` holds every `sha256(token)` that opens the management API.
`package-history/*.json` holds the bundle URLs, which are unguessable-by-design public
capability URLs.

Therefore:

* **Never point `<output-dir>` inside a git checkout.** Nothing here is gitignored,
  because nothing here should ever be near the repo. Use a path outside it.
* Store it where the Supabase service-role key is stored, not where source is.
* **Delete a dump once its import is verified.** A daily cron should rotate, not
  accumulate — keep the last few runs and remove the rest.
* An export that has been read by anyone who should not hold a deployment key means
  rotating that key, which is the one thing this migration exists to avoid: a new key
  strands every fielded till on that channel forever.

---

## Prerequisites

**For the export** — the same variables the server already reads from `api/.env`:

| variable | used for |
|---|---|
| `AZURE_STORAGE_ACCOUNT` | table + blob endpoints |
| `AZURE_STORAGE_ACCESS_KEY` | table + blob auth |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_KEY` | metrics (DB 1) |

**For the import**:

| variable | used for |
|---|---|
| `SUPABASE_URL` | PostgREST + Storage base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | writes |

The importer needs the **service-role** key, not the `codepush_api` JWT the container
runs with: it writes objects into a bucket that is service-role-write-only by design.
That is correct for a one-shot tool run from a laptop and wrong for anything shipped —
**the service-role key never belongs in the container's environment.**

Also required, both by a **human**, before the import:

1. **Migration `803_codepush_core.sql` applied** (dev project first). Claude may author a
   migration but never applies one — see `CLAUDE.md`, *"No direct database changes"*.
2. **The `LazyWaitCodePush` bucket created**, public read, `file_size_limit ≥ 100 MB`
   (real bundles are ~30 MB; `UPLOAD_SIZE_LIMIT_MB=100` is the server-side cap),
   `allowed_mime_types` null or including `application/zip` +
   `application/octet-stream` + `application/json`.

### Why a dedicated bucket (this supersedes the migration design doc)

The design put bundles in the shared `LazyWaitStorage` bucket under a `codepush/` prefix.
That was changed to a dedicated `LazyWaitCodePush` bucket, path `blobs/{blobId}`, because:

* `file_size_limit` is a **per-bucket** setting shared with every tenant upload path.
  Raising it to fit a 30 MB bundle raises it for every cashier.
* `LazyWaitStorage`'s documented invariant is that its root holds only `partner/` and
  `retail_db/`.
* A dedicated bucket does not depend on the drifted policy state of migrations 024 / 601.

**How the new bucket is actually protected** (an earlier revision of this file described
policies that 803 does not contain — read the migration, not this paragraph, if they ever
disagree again):

* `024_storage_rls_lazywaitstorage.sql` scopes its blanket `authenticated`
  INSERT/UPDATE/DELETE policies to `bucket_id = 'LazyWaitStorage'`, so they do **not** reach
  `LazyWaitCodePush`. No permissive write policy for anon/authenticated on the new bucket
  means denied — that is the first layer.
* 803 then adds `codepush_bucket_no_insert` / `_no_update` / `_no_delete`, **`AS RESTRICTIVE`
  `TO anon, authenticated`** with the predicate `bucket_id <> 'LazyWaitCodePush'`. Restrictive
  policies AND with everything else, so a write aimed at this bucket evaluates FALSE and is
  refused **whatever** permissive policy anyone adds later. That is the second layer, and it
  is the one that survives a future bucket-agnostic grant of the kind 024 shipped. They are
  per-command, never `FOR ALL`: a restrictive `FOR ALL` would also cover SELECT and 403 the
  bundle downloads the fleet depends on.
* Writes by the server go through `codepush_api_bucket_rw` (permissive, `FOR ALL TO
  codepush_api`, `bucket_id = 'LazyWaitCodePush'`) plus the matching GRANTs on
  `storage.objects` — which is why one credential covers both PostgREST and Storage and no
  service-role key is needed anywhere.

Verify both layers with `codepush:verify` checks 8 and 9 rather than by reading policy names.

---

## Order to run

```
1.  yarn build                          # in api/  -- compiles script/ -> bin/script/
2.  node bin/script/scripts/export-azure.js ./export --include-clients
        ... repeat daily; each run is a new export-<UTC> directory ...
3.  (human) apply 803 to the DEV Supabase project; create the bucket
4.  node bin/script/scripts/import-supabase.js ./export --confirm --dry-run    # dev
5.  node bin/script/scripts/import-supabase.js ./export --confirm              # dev
6.  ... verify (below), run the dev end-to-end, then repeat 3-5 on PROD ...
```

At **FLIP B** (design §D, "The cutover"), the sequence is:

```
a.  export-azure.js ./export                       # full run against live Azure
b.  import-supabase.js ./export --confirm --merge   # long; Azure still serving
c.  set DISABLE_MANAGEMENT=true on the Azure container   <-- a freeze, not an announcement
d.  export-azure.js ./export                       # incremental: new run, re-reads the table
e.  import-supabase.js ./export --confirm --merge   # picks up only what changed
f.  verify (below)
g.  swap CODEPUSH_TAG; set CODEPUSH_BASE_URL; restart lazywait-api
h.  unfreeze; one real `release --rollout 1%` to Staging, NON-MANDATORY, watched on a till
```

---

## Export

```
node bin/script/scripts/export-azure.js <output-dir> [flags]
```

| flag | effect |
|---|---|
| `--resume` | reuse the newest `export-*` run directory under `<output-dir>` |
| `--run <id>` | reuse/create a named run directory |
| `--force` | redo every step even if its output file exists |
| `--skip-redis` | skip the metrics dump *(this is the only copy — think first)* |
| `--skip-blobs` | skip the two container inventories |
| `--include-clients` | also dump `deploymentKeyClients:*` field contents (one field per device) |
| `--no-tls` | connect to Redis without TLS (local instance only) |

It **never writes to Azure**. It opens the table and blob clients directly rather than
constructing `AzureStorage`, whose `setup()` *creates* the table, both containers and
three health entities as a side effect (`azure-storage.ts:998-1012`) — an export must not
be able to resurrect a container someone just deleted. It also reads **raw** entities
rather than going through `AzureStorage.unwrap()`, which drops `createdTime` for every
row where it did not arrive as a bigint (`:1108-1120`).

**Resuming:** re-run the same command with `--resume` (or `--run <id>`). Any step whose
output file already exists is skipped, and package-history blobs are one file per
deployment, so an interrupted run picks up where it stopped. Partial writes go to
`<name>.partial` and are renamed only on success — a killed process can never leave a
truncated file that a later run would trust.

### What a run directory contains

```
<output-dir>/
  latest.json                       # newest run + whether it completed
  export-20260907T101500Z/
    manifest.json                   # run metadata + the count summary
    table-storagev2.jsonl           # EVERY row, verbatim, one JSON per line
    entities/
      account.json                  # the real account rows (email partition)
      account_pointer.json          # accountId -> email pointer
      app.json                      # app leaf rows, collaborators as a JSON STRING
      app_pointer.json              # account -> app pointers
      deployment.json               # deployment leaf rows, incl. `key` and `package`
      access_key.json               # `name` is ALREADY sha256(plaintext)
      access_key_pointer.json       # accessKey <hash> -> {accountId, expires}
      deployment_key_pointer.json   # deploymentKey <key> -> {appId, deploymentId}
      health.json, unknown.json
    package-history/<deploymentId>.json
    blobs-storagev2.json            # bundle/manifest/diff inventory
    blobs-packagehistoryv1.json     # history blob inventory
    redis-metrics.json              # DB 1 hashes, client-hash sizes, orphan keys
```

`entities/*.json` are the same rows as the JSONL, grouped by row shape with the ids
decoded out of the key grammar. The JSONL is the belt-and-braces archive: nothing is
classified away.

### What to check after an export

* `manifest.json` → `complete: true` and `counts.row_unknown` is **0**. A non-zero
  `unknown` means a row shape this decoder does not recognise — read
  `entities/unknown.json` before importing anything.
* **Every deployment has a shortcut row** — a deployment with no
  `deploymentKey <key>` pointer cannot be resolved by key, which is how every device
  addresses it. Check that direction only: `row_deployment_key_pointer` is legitimately
  **higher** than `row_deployment`, because `removeDeployment` deletes only the `appId`
  partition (`azure-storage.ts:1344-1361`) and orphans the shortcut row forever. The live
  account had 43 pointers for 40 deployments on 2026-09-07 — three deleted deployments.
  Orphan pointers are not imported (nothing references them) and are harmless.
* `counts.package_history_missing` is 0, or you know why. A deployment with no history
  blob is recovered by the importer from the `package` JSON string on its own row, but
  that recovers **only the current release**, not the history. Note that an *empty*
  history is different and entirely normal — a Staging channel nobody has released to.
  On the live account, 25 of 40 deployments were empty and 219 packages sat in the
  other 15.
* `redis-metrics.json` → `orphan_deployment_keys`. Expect this to be non-empty and to
  roughly match the orphan-shortcut count above (four on the live account, 2026-09-07):
  metrics for deployments whose table row is gone. The importer warns and drops them.
* Eyeball the three production deployment keys in `entities/deployment.json`
  (Android / iOS / Windows). They are what makes the whole cutover safe.

---

## Import

```
node bin/script/scripts/import-supabase.js <export-dir> --confirm [flags]
```

`<export-dir>` is either an `export-*` run directory or the parent directory of one
(then `latest.json` picks the newest complete run).

| flag | effect |
|---|---|
| `--confirm` | **required.** Without it the script writes nothing and exits non-zero. |
| `--merge` | **required** when the target project already holds `codepush_*` rows |
| `--dry-run` | perform every read and every check, write nothing |
| `--skip-blobs` | do not copy blob bytes (rows still get their rewritten URLs) |
| `--skip-metrics` | do not import Redis metrics — **use this on any post-cutover re-run** |
| `--allow-missing-blobs` | a blob gone from Azure becomes a warning, not an error (still an error for a deployment's *current* package) |
| `--allow-missing-timestamps` | a row with no `createdTime`/`uploadTime` becomes a warning and takes `DEFAULT now()` |
| `--concurrency <n>` | parallel blob copies, default 4 |

### The two refusals

1. **No `--confirm` ⇒ nothing happens.** This script writes to a live Supabase project.
2. **Target already holds `codepush_*` rows ⇒ refuses unless `--merge`.** It counts all
   nine tables first and prints which ones are populated. This exists so a second,
   accidental import cannot walk a live project's data backwards.

### Idempotency, and the one thing that is not

Every row is addressed by its natural key — the Azure shortid, `(deployment_id, label)`
for packages, the blobId for a storage object — and upserted. Blob bytes are skipped when
**both** the `codepush_blob` ledger row and the storage object already exist (a ledger row
without an object is a package pointing at a 404, which is the state that bricks a till on
a mandatory release). Re-running after an interruption is the intended recovery path.

**The exception is metrics.** They are written **absolutely** (`count = <snapshot>`), not
as a delta — `codepush_bump_metrics` adds and is deliberately *not* used here, because a
second import would otherwise double every counter. The consequence: once the new server
is live and the fleet is reporting, a re-import would clobber live counters with the
frozen Azure numbers. **Always pass `--skip-metrics` on a post-cutover re-run.**

### What the importer refuses to guess

Each of these is a hard error that aborts with a non-zero exit and a named row, rather
than a silent drop:

* an app grant whose `accountId` is unknown *and* whose email matches no account —
  that grant decides who may release to Production;
* an access key with no `expires` — dropping it silently revokes a token someone is
  using right now;
* two accounts that differ only by email casing (803's uniqueness is on `lower(email)`);
* two labels in one deployment that derive the same `seq`;
* a `releaseMethod` outside `Upload` / `Promote` / `Rollback`;
* a missing `createdTime` / `uploadTime` (unless `--allow-missing-timestamps`);
* a bundle blob that no longer reads from Azure *and* backs a deployment's current
  package (unless `--allow-missing-blobs`).

### The four invariants it enforces

1. **`deployment_key` verbatim** — and *asserted* after the write, per deployment, by
   reading the rows back and byte-comparing. A regenerated key strands every fielded till
   on that channel forever, with no OTA path to fix an OTA channel.
2. **`access_key.name_hash` verbatim** — the `name` column on the Azure row is already
   `sha256(plaintext)` (`azure-storage.ts:1236-1239`), so it is copied straight across and
   every CLI token, every `.code-push.config` and the dashboard proxy's
   `CODEPUSH_AUTH_TOKEN` keep working.
3. **Timestamps from the source, never `DEFAULT now()`** — `created_at` from `createdTime`,
   `uploaded_at` from `uploadTime`. Defaulting them stamps all 50 releases of every
   deployment with the cutover date, which *is* losing the history in the only form
   anyone reads.
4. **`label_counter = GREATEST(max(seq), max(label suffix))`, never the row count** —
   `seq` is derived from the label (`v(\d+)`), never from the array index, because the
   history blob is a rolling window and index+1 renumbers every release each time it
   slides. The counter is also only ever moved **upward**: if a release landed on the new
   server between two runs, the live counter wins.

### Blobs

`blob_url`, `manifest_blob_url` and every `diff_package_map[*].url` are rewritten to
`{SUPABASE_URL}/storage/v1/object/public/LazyWaitCodePush/blobs/{blobId}`. The blobId is
taken from the last path segment of the Azure URL and preserved end to end — that is what
makes the copy re-runnable and keeps `codepush_blob.id` equal to the `generateSecureKey()`
value the server originally minted.

The download half needs **no Azure credential**: the container is created with
`{access:"blob"}` (`azure-storage.ts:1001`) and `getBlobUrl` returns a bare URL with no
SAS (`:809-814`).

`codepush_package_diff_blob` is populated alongside, so the GC sweep in design step 8 can
answer "is this blob still referenced?" without a full scan and a JSONB string-parse.

---

## What to verify after the import

Run the **VERIFY** block in the APPLY NOTE at the bottom of
`LazyWaitInternalAPI/supabase/migrations/803_codepush_core.sql`. It is the reference; do
not copy it here, it will drift. Two corrections to it, both from the bucket decision
above:

* its query **(3)** ("prefix is not writable by a tenant JWT") should target
  `supabase.storage.from('LazyWaitCodePush').upload('blobs/probe', …)` — expect a failure;
* its query **(4)** ("prefix IS readable anonymously") should be
  `curl -I https://<project>.supabase.co/storage/v1/object/public/LazyWaitCodePush/blobs/<id>`
  — expect **200**. A 403 here is the one state that bricks a till while a mandatory
  release is live: `update_check` 200s with `is_mandatory`, the blocker owns the screen,
  the download 403s, the only button is Retry, and relaunch re-enters the loop. There is
  no way to ship the fix OTA. **Verify this from off-network, with no auth header, against
  a real ≥50 MB object, BEFORE the flip.**

Beyond 803's queries, check:

* **The importer's own summary line.** `errors 0`. It exits non-zero otherwise.
* **`label_counter >= top_label` for every deployment** — 803's query (1) covers this, and
  it is the check that catches the rolling-window trap.
* **`oldest < now() - interval '1 day'`** in that same query — this is the proof that
  `uploadTime` was imported rather than defaulted.
* **The three production deployment keys**, by eye, against the export
  (`entities/deployment.json`). The importer asserts this too, but this is the one worth
  a human's eyes.
* **`code-push deployment history <app> Production` against the new server** returns the
  same labels, in the same order, with the same dates as against Azure. This is the
  acceptance test a human recognises.
* **Metrics are non-negative and non-zero** where the fleet is active:
  `SELECT deployment_id, label, status, count FROM codepush_deployment_metric ORDER BY 1,2,3;`

---

## Baseline — a real run against the live account, 2026-09-07

`export-azure.js` was run READ-ONLY against production while writing these scripts. Use
these as the shape to expect, not as targets:

```
table rows                 221   (unknown 0, health 0)
  account 4 · account_pointer 4 · app 20 · app_pointer 50
  deployment 40 · access_key 30 · access_key_pointer 30 · deployment_key_pointer 43
package history            40 files, 219 packages, 0 blobs missing
  25 of 40 deployments have an EMPTY history (Staging channels never released to)
  1 deployment's window has SLID: its history starts at v46 -- 45 releases trimmed
blob inventory             557 objects, 4.93 GB  (packagehistoryv1: 43 objects, 117 KB)
redis DB 1                 44 metric hashes, 1020 fields, 3 client hashes, 4 orphan keys
```

Two of those lines are the whole reason the importer is written the way it is:

* **`first label = v46` on a live deployment.** `seq = index + 1` would set
  `label_counter = 50` and the next release would be labelled `v51` — a label already
  installed on tills. The rolling-window trap is not hypothetical on this account.
* **`health 0`.** There is no `health`/`health` row in `storagev2`, so
  `AzureStorage.checkHealth()`'s `getEntity("health","health")` rejects with
  `ResourceNotFound` and the Azure server's `/health` cannot be passing its table check
  today. Worth knowing before anyone uses `/health` as the cutover's go/no-go signal.

All 30 access-key `name` values are 64-char lowercase hex (sha256, as expected); no
account, deployment or package was missing its timestamp.

---

## Known limits, stated deliberately

* **Not migrated:** the update-check response cache (Redis DB 0 — it rebuilds itself in an
  hour), `deploymentKeyClients:*` (per-device state; the replacement `RedisManager` keeps
  those methods as no-ops, and the export records only the hash sizes unless
  `--include-clients`), and orphan blobs with no package row (they are the leak the
  `codepush_blob` ledger exists to collect — the GC sweep in design step 8 removes them).
* **A blob that is gone from Azure** leaves the package row with its rewritten URL and a
  NULL `blob_id`. That is the same 404 the row has today, not a new one, and the NULL FK
  keeps the ledger honest.
* **`codepush_blob.account_id` stays NULL.** Nothing in the Azure record says which
  account uploaded a historical blob.
* **`codepush_blob.created_at` takes `DEFAULT now()`** — deliberately. A blob's upload
  time is not recorded anywhere in the Azure table; the timestamp that matters is the
  package's `uploaded_at`, which is imported from the source.
* **The point of no return is the first post-cutover release.** Once one release lands in
  Postgres only, reverting makes Azure's `packagehistoryv1` authoritative and it has never
  seen that release — the whole fleet is then offered a downgrade, and if any pre-cutover
  release still carries `-m`, that downgrade is mandatory. Either releases stay frozen for
  the entire rollback window, or the rollback is declared unavailable after the first
  post-cutover release. Pick one, in writing, before step (h).
