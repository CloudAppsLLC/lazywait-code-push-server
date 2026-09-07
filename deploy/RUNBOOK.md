# CodePush off Azure — cutover runbook

Phase-by-phase, in order, one checkbox per step. Every step is tagged **[HUMAN]** or
**[AUTOMATED]**, and carries the command that proves it worked and the command that
undoes it.

**[AUTOMATED]** means *the code to do it exists and is committed* — a person still types
the command. It never means "it happens by itself". Two things genuinely happen by
themselves once configured and both are called out where they appear: the GHCR poller on
the VPS, and the daily export cron.

**[HUMAN]** is not a courtesy. Applying a migration, creating a bucket, deploying,
touching DNS, changing an Azure resource, or running the importer are acts an agent must
not perform (`LazyWaitInternalAPI/CLAUDE.md`, *"No direct database changes"*, enforced by
`functions/src/scripts/_dbApplyGuard.ts`; the same rule is applied here to deploys and
cloud resources). If a step is marked [HUMAN], a human types it, on purpose, having read
the line above it.

---

## The five rules that outrank every step below

1. **The first release after FLIP B is NON-MANDATORY. Unconditionally.**
   A dead server does not raise the update gate — `INITIAL.isMandatory` is `false`, so a
   failed check degrades to a POS running its current bundle. **A working server handing
   out a bundle URL that 403s is what bricks a till**: `update_check` 200s with
   `is_mandatory` → `CodePushBlocker` owns the screen → the download fails →
   `SyncStatus.UNKNOWN_ERROR` → `phase:'error'`, which is *deliberately inside*
   `isMandatoryBlocking` → the gate stays up, the only button is Retry, and relaunch
   re-enters the same loop (`CodePushWrapper.tsx:141-159`,
   `codePushUpdateStore.ts:102-114`). `onDevDismiss` is `undefined` in release builds.
   There is no way to ship the fix OTA, because OTA is the broken thing.

2. **Clear every outstanding mandatory release before either flip.**
   `LazyWaitOne/scripts/codepushRelease.js:639-677` (`clearStaleMandatoryReleases`) does it
   with `patch … -m false`.

3. **One replica. Always.**
   The update-check cache is an in-process `Map` and `invalidateCachedPackage` is the only
   thing that makes a release visible before the hour is up. Two containers = a release
   that half the fleet cannot see for an hour, and rate limits that count half the
   traffic. Do not add an upstream pool to the Caddy block, do not scale the service.

4. **A container restart is a cache flush.** The whole fleet's next check goes to
   PostgREST at once. Never restart, redeploy, or let the GHCR poller fire during a
   release or a rollout.

5. **The point of no return is the FIRST post-cutover release.** Once one release exists
   only in Postgres, reverting makes Azure's `packagehistoryv1` authoritative and it has
   never seen that release — the fleet is then offered a downgrade, and if any
   pre-cutover release still carries `-m`, that downgrade is mandatory. Either releases
   stay frozen for the whole rollback window, or the rollback is declared unavailable
   after the first post-cutover release. **Pick one, in writing, before phase 7 step (h).**

---

## Preflight probes — run before phases 4, 6 and 7, and any time you want the truth

- [ ] **P1 [AUTOMATED] Mint the container credential** (once per project; re-mint only to
      rotate).
  ```
  cd api && yarn build
  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_JWT_SECRET=<project jwt secret> \
    yarn codepush:mint-jwt --expires 10y
  ```
  It verifies the token against the project before printing it, so a wrong secret fails
  here instead of as an opaque 500 three days later. The secret is never printed.
  **Never substitute the service-role key** — it bypasses RLS on every table in the
  project (`pos_orders`, `hrms_employees`, `platform_support_access_log`) and would give
  this fork a strictly larger blast radius than the Azure storage-account key it replaces.

- [ ] **P2 [AUTOMATED] Preflight the project** — read-only, safe against production.
  ```
  SUPABASE_URL=… SUPABASE_CODEPUSH_JWT=… SUPABASE_ANON_KEY=… yarn codepush:verify --strict
  ```
  Ten lines, pass/fail each: the JWT resolves to `codepush_api`; all nine `codepush_*`
  tables reachable; both RPCs callable; the `LazyWaitCodePush` bucket exists, is public
  and has `file_size_limit ≥ 100 MB`; **an object under `blobs/` is readable with no auth
  header**; a tenant JWT cannot write to the bucket or read `codepush_access_key`.
  `--strict` turns a SKIP into a failure — use it at every gate.

- [ ] **P3 [HUMAN] Repeat the anonymous read from OFF-NETWORK, against a real bundle.**
      A phone on cellular, not the laptop that just passed P2, and against a ≥50 MB
      object. This is rule 1's precondition and the one check a green script cannot fully
      stand in for.
  ```
  curl -I https://<ref>.supabase.co/storage/v1/object/public/LazyWaitCodePush/blobs/<blobId>
  ```
  Expect `200`. A `403` here means **stop**.

- [ ] **P4 [AUTOMATED] Which build is actually serving?**
  ```
  curl -s https://codepush.lazywait.com/version
  ```
  → `{ sha, short_sha, built_at, storage_backend, uptime_seconds }`. CI being green and
  the container running that image are two separate facts; this is the only one that
  matters. `storage_backend` is `azure` before FLIP B and `supabase` after — during the
  cutover it is the single most useful field on the box.

---

## Phase 0 — Find out what Azure is actually billing

- [ ] **0.1 [HUMAN] Pull the resource group's Cost Analysis export** (last 30 days, daily
      granularity, by resource).
      Every figure in the design is a **full-month run rate** derived from a 19-day
      partial invoice (×1.6337). Confirm against your own export before quoting a saving
      to anyone.
- [ ] **0.2 [HUMAN] Open the Notification Hubs namespace → Metrics blade.** Incoming
      Messages, Outgoing Messages, Registration count, 30 days.
      **Do not settle this by grepping the repo.** The code path is dead
      (`functions/src/shared/push/wns.ts:113-119` records the decommission), but whether
      the *resource* still bills and whether anything still transacts with it are portal
      facts this repo cannot answer.
  - *Verification:* a screenshot of both blades attached to the cutover ticket.
  - *Rollback:* n/a (read-only).

---

## Phase 1 — Notification Hubs: Standard → Basic

This is ~SR1,314/month for one hour of work and no code. It is the entire economic case
for the project; everything after it is about owning the stack.

- [ ] **1.1 [HUMAN] Downgrade the namespace Standard → Basic** in the portal.
  - *Verification:* the namespace shows tier `Basic`; the next daily cost export shows the
    line collapse.
  - *Rollback:* upgrade back to Standard in the portal. Reversible, same blade.
- [ ] **1.2 [HUMAN] Do NOT delete the namespace yet.** It gets the same two-week soak as
      everything else, in phase 8.

---

## Phase 2 — Export the only data that cannot be re-derived

Three things exist nowhere else: the `storagev2` table (who owns what, which token hash
opens the management API, **which deployment key is compiled into which shipped binary**),
the `packagehistoryv1` blobs, and **Redis DB 1** (the deployment metrics — `grep -rn
metric script/storage` returns zero hits, so Redis is the only copy, and status reports
are fire-and-forget; a lost counter is worse than a zeroed one because `recordUpdate`
*decrements* the previous label, so an empty `Active` drifts permanently negative).

- [ ] **2.1 [AUTOMATED, run by a HUMAN] First full export.**
  ```
  cd api && yarn build
  node bin/script/scripts/export-azure.js /srv/codepush-export --include-clients
  ```
  Read-only against Azure. It opens the table and blob clients directly rather than
  constructing `AzureStorage`, whose `setup()` *creates* the table and containers as a
  side effect — an export must not be able to resurrect a container someone just deleted.
- [ ] **2.2 [HUMAN] Put the run directory somewhere secret.** It holds every deployment
      key in plaintext and every `sha256(token)` that opens the management API. **Never
      inside a git checkout.** Store it where the service-role key is stored.
- [ ] **2.3 [HUMAN] Cron it daily, from today**, rotating (keep the last few runs).
      The Redis instance is the thing most likely to be deleted by accident.
- [ ] **2.4 [HUMAN] Read `manifest.json`.** `complete: true`, `counts.row_unknown` is
      **0**, `counts.package_history_missing` is 0 or understood, and
      `redis-metrics.json.orphan_deployment_keys` roughly matches the orphan-shortcut
      count. Eyeball the three production deployment keys (Android / iOS / Windows) in
      `entities/deployment.json`.
  - *Verification:* `latest.json` names a complete run; the counts above.
  - *Rollback:* delete the run directory. Nothing was written to Azure.

---

## Phase 3 — Schema and bucket (dev first, then prod)

- [ ] **3.1 [HUMAN] Re-check the migration number at apply time.**
      `803_codepush_core.sql` was numbered when 802 was the highest — and this repo
      already carries duplicate numbers (`788` ×2, `789` ×2, `792` ×2). Look before you
      apply.
- [ ] **3.2 [HUMAN] Apply `803_codepush_core.sql` to the DEV project.**
      It is re-runnable in full (every statement is `IF NOT EXISTS` / DROP-then-CREATE /
      exception-guarded). It creates a **cluster-scoped role** and a policy on
      `storage.objects`, which is shared with every tenant upload path — this is not a
      "just the codepush tables" change.
  - *Verification:* the `VERIFY` block in the file's APPLY NOTE, then **P2**.
  - *Rollback:* the `ROLLBACK` block at the bottom of the same file, in the order given
    (`DROP ROLE` fails while any grant survives). Safe while Azure is still serving. It
    deliberately does **not** drop the bucket or its objects.
- [ ] **3.3 [HUMAN] Create the `LazyWaitCodePush` bucket on DEV** — dashboard or CLI.
      803 deliberately does not create it: bucket creation is a project-level act and
      `storage.buckets` ownership differs across Supabase versions.
      `public: true`, `file_size_limit: 157286400` (150 MB), `allowed_mime_types: null`
      (or `application/zip`, `application/json`, `application/octet-stream`).
      **Public is load-bearing**: `blob_url` is persisted forever, copied verbatim by
      Promote/Rollback, cached by the SDK across restarts, and re-fetched weeks later by
      the differ with a bare `superagent.get`. A signed URL expires; these must not.
  - *Verification:* **P2** check 7 goes green.
  - *Rollback:* delete the bucket (only while it is empty and nothing points at it).
- [ ] **3.4 [HUMAN] Confirm the two role memberships landed.**
      803 does `GRANT codepush_api TO authenticator` and `TO supabase_storage_admin`
      inside `DO` blocks that **downgrade to a NOTICE** when the role name is absent.
      PostgREST does not connect as the JWT's role — it connects as `authenticator` and
      issues `SET ROLE` per request, which is only permitted if `authenticator` is a
      member. Miss it and *every* request fails at the connection level, before any policy
      or grant is consulted.
  - *Verification:* **P2** check 2 — it names this failure mode explicitly.

---

## Phase 4 — Tier 1: the storage conformance harness

One command. It runs the preflight first and only then the harness, because a red harness
against a project whose bucket does not exist costs an afternoon in the wrong file.

- [ ] **4.1 [AUTOMATED] Run Tier 1 against DEV.**
  ```
  cd api
  SUPABASE_URL=<dev> SUPABASE_CODEPUSH_JWT=<dev codepush_api jwt> \
  CODEPUSH_PROD_SUPABASE_URL=<prod url> \
    yarn test:tier1
  ```
  Setting `CODEPUSH_PROD_SUPABASE_URL` is how the harness is stopped from ever running
  against production: `--conformance` refuses when the target equals it. **The harness
  WRITES** — one account, two apps, two deployments, ~8 packages. It removes the apps
  again (which is itself one of the checks), but `Storage` has no account-delete verb, so
  each run leaves one `codepush_account` row behind by design.
- [ ] **4.2 [AUTOMATED] The JsonStorage leg alone**, for a checkout with no cloud
      credentials: `yarn test:conformance`. This is what CI runs.
  - *Verification:* `PASS -- 0 failing check(s)`, with the SupabaseStorage leg listed, not
    skipped.
  - *Rollback:* n/a — but if a check about **array order** is red, do not "fix" it by
    sorting. Ascending (oldest first) is the contract; a descending history offers the
    entire fleet a downgrade at HTTP 200 with `is_available: true` and logs nothing.
  - *If the label-text check after `clearPackageHistory` is red:* read the divergence note
    in the harness header before touching anything. `label_counter` is monotonic on
    purpose. Resetting it reintroduces label reuse under a unique index that now forbids
    it, and the second post-clear release 23505s the release pipeline dead.

---

## Phase 5 — Dev end-to-end

- [ ] **5.1 [HUMAN] DNS: `codepush-dev.lazywait.com` → the VPS (8.213.81.231).**
      The A record must exist *before* Caddy first starts the vhost, or ACME retries
      forever.
- [ ] **5.2 [HUMAN] Bring up the dev container** on the existing external network, with
      `CODEPUSH_STORAGE_BACKEND=supabase` and the dev Supabase credentials
      (Appendix A is the full env).
- [ ] **5.3 [HUMAN] Real CLI, real curl, on a real device.** `code-push-standalone` login
      → `app list` → `release` → `deployment history` → an update check from a till
      pointed at the dev key.
  - *Verification:* `curl -s https://codepush-dev.lazywait.com/version` reports
    `storage_backend: "supabase"`; `/health` returns 200 — the body is `Healthy` when
    `CODEPUSH_METRICS_BACKEND=supabase` (the Postgres metrics ARE probed, and a broken
    schema fails here), and `Healthy (no cache configured)` when no metrics backend is
    configured at all, which is a deployment choice and not a fault;
    a release appears in `deployment history` with the right label and date.
  - *Rollback:* stop the dev container. Nothing production touches it.

---

## Phase 6 — FLIP A: the network only

Container on the VPS running the **existing `AzureStorage` backend** — same table, same
blobs, same data. The only new variables are DNS, TLS, Caddy, the container and the proxy.
**Soak 7 days.**

- [ ] **6.1 [HUMAN] DNS: `codepush.lazywait.com` → 8.213.81.231.**
- [ ] **6.2 [HUMAN] Add the Caddy vhost — in the COMMITTED `deploy/vps/Caddyfile`**, not
      by editing the file on the server (the checkout is bind-mounted; a server-side edit
      is wiped by the next `git pull`).
  ```
  codepush.lazywait.com {
      encode gzip
      request_body { max_size 120MB }        # must exceed UPLOAD_SIZE_LIMIT_MB
      reverse_proxy lazywait-codepush:9002 {
          transport http { read_timeout 300s  write_timeout 300s }
      }
      import accesslog                       # needed by step 9.3 — do not omit
  }
  ```
  No `tls` directive: ACME HTTP-01, contact `asad@lazywait.com`.
  Reload: `docker exec lazywait-caddy caddy reload --config /etc/caddy/Caddyfile`.
- [ ] **6.3 [HUMAN] Start the container** —
      `ghcr.io/cloudappsllc/lazywait-code-push-server:${CODEPUSH_TAG:-latest}`,
      `container_name: lazywait-codepush`, `restart: unless-stopped`, on the existing
      external network. Ports `127.0.0.1:9002:9002` (9000 prod and 9001
      dev are taken), `mem_limit: 2g`, `cpus: 0.5`, `logging: json-file, max-size 50m,
      max-file 3` (non-negotiable — there is a 25 GB Caddy-log precedent on this box),
      healthcheck **via node**, not wget/curl (the runtime image has neither, which is why
      the prod API container permanently reports `(unhealthy)` while serving 200s).
      **`CODEPUSH_STORAGE_BACKEND` stays UNSET here.** This flip moves the network only.
- [ ] **6.4 [HUMAN] Replace the App Service content with a transparent reverse proxy** to
      `codepush.lazywait.com` (method, path, query, headers, body preserved; stamp
      `X-Legacy-Host: azure`). **Do not delete `codepushapp`** — its hostname is baked into
      every shipped binary and lives in Microsoft's DNS zone. It cannot be repointed and
      the last OTA served from Azure cannot redirect anyone.
- [ ] **6.5 [HUMAN] Downgrade the App Service plan S1 → B1.** Not F1 — its daily CPU quota
      stops the proxy dead. This is where the App Service saving is banked.
- [ ] **6.6 [HUMAN] Soak 7 days.** No releases during the soak unless they are
      non-mandatory and watched.
  - *Verification:* `curl -s https://codepush.lazywait.com/version` →
    `storage_backend: "azure"`; the same `code-push deployment history` output through
    both hostnames; tills polling through the Azure proxy still get updates.
  - *Rollback:* redeploy the old App Service zip. The data plane was never touched, so
    this is a full revert with no data consequence.

---

## Phase 7 — FLIP B: the data only

Network path unchanged. One environment variable and a tag.

- [ ] **7.0 [HUMAN] Rule 2: clear every outstanding mandatory release.** And re-run
      **P2 `--strict`** and **P3** against the PROD project first. Phase 3 repeats here:
      apply 803 to prod, create the prod bucket.
- [ ] **7.1 [AUTOMATED, run by a HUMAN] Full export, then a long import while Azure is
      still serving.**
  ```
  node bin/script/scripts/export-azure.js /srv/codepush-export
  node bin/script/scripts/import-supabase.js /srv/codepush-export --confirm --merge --dry-run
  node bin/script/scripts/import-supabase.js /srv/codepush-export --confirm --merge
  ```
  The importer needs the **service-role** key, not the container's `codepush_api` JWT —
  correct for a one-shot tool run from a laptop, and wrong for anything shipped. **The
  service-role key never enters the container's environment.**
- [ ] **7.2 [HUMAN] Freeze management on Azure** — `DISABLE_MANAGEMENT=true` on the Azure
      container. A freeze, not an announcement: it is what makes the incremental import
      below complete rather than chase.
- [ ] **7.3 [AUTOMATED, run by a HUMAN] Incremental export + import.** Same two commands;
      each is idempotent and addresses rows by natural key.
- [ ] **7.4 [AUTOMATED] Verify the import.**
      Run 803's `VERIFY` block, then **P2 `--strict`**, then by eye:
      `label_counter >= top_label` for every deployment (the rolling-window trap:
      a deployment with 86 releases holds labels **v37…v86** in 50 slots, and the live
      account already has one whose window has slid — first label `v46`);
      `oldest < now() - interval '1 day'` (proves `uploadTime` was imported, not
      defaulted); the three production deployment keys byte-identical to
      `entities/deployment.json`; metrics non-negative.
- [ ] **7.5 [HUMAN] Swap the container to the Supabase backend.**
      `CODEPUSH_STORAGE_BACKEND=supabase`, `CODEPUSH_TAG=<supabase-capable tag>`,
      `docker compose up -d`.
- [ ] **7.6 [HUMAN] Point the Internal API at the new host.**
      `CODEPUSH_BASE_URL=https://codepush.lazywait.com/apps` — **keep the trailing
      `/apps`**: `codepushFetch('/')` *is* the app list/create call and all nine call sites
      are relative to it. It is read at module scope, so this needs a **restart** of
      `lazywait-api`, not a reload. Today it is unset and the hardcoded Azure default at
      `config/env.ts:172` is live.
- [ ] **7.7 [HUMAN] Unfreeze, then ONE release: `--rollout 1%`, to Staging,
      NON-MANDATORY, watched on a real till.** Rule 1.
  - *Verification:* `/version` reports `storage_backend: "supabase"`;
    `code-push deployment history <app> Production` returns the same labels, in the same
    order, with the same dates as it did against Azure; the watched till installs the 1%
    release.
  - *Rollback:* `CODEPUSH_TAG=<old>` + `CODEPUSH_STORAGE_BACKEND` unset +
    `docker compose up -d` — about ten seconds, and the Azure data plane is intact.
    **This rollback dies at rule 5**, the moment a release lands in Postgres only.
  - *On any post-cutover re-run of the importer: pass `--skip-metrics`.* Metrics are
    written absolutely, not as a delta, so a re-import clobbers live counters with the
    frozen Azure numbers.

---

## Phase 8 — Delete the Azure resources (after a 2-week soak)

- [ ] **8.1 [HUMAN] Two weeks after FLIP B**, with no rollback used, delete: the Redis
      cache, the Storage account, and the Notification Hubs namespace.
      **Not `codepushapp`** — that stays until phase 9.
  - *Verification:* the next daily cost export shows the lines gone; `/health` and
    `/version` unchanged; a release still works.
  - *Rollback:* none. This is why it is two weeks and why phase 2's export is cron'd.
- [ ] **8.2 [HUMAN] Ship the blob GC sweep in the same window.**
      `removeBlob()` has no caller anywhere in `api/script`, and `removeApp` /
      `removeDeployment` delete only the history blob — every bundle, manifest and diff
      ever uploaded is still stored (557 objects, 4.93 GB on the live account).
      `codepush_blob` + `codepush_package_diff_blob` exist so the sweep is a real query:
      `deleted_at IS NULL AND NOT EXISTS (blob_id / manifest_blob_id / diff-blob)`.
      **Sweep on a dry run first and read the list before deleting anything.**

---

## Phase 9 — New store builds, then retire the App Service

- [ ] **9.1 [HUMAN] Four literal edits**, no partner tooling involved:
      `android/app/src/main/res/values/strings.xml:9`,
      `ios/lazywaitone/Info.plist:54`,
      `windows/lazywaitone/lazywaitone.cpp:374`,
      `windows.paper/lazywaitone/App.xaml.cs:145` → `https://codepush.lazywait.com`.
      Partner Android builds inherit `main`'s `strings.xml` (the partner patcher stamps
      only the **deployment key**, never the URL), so one edit propagates.
      TLS: iOS sets `NSAllowsArbitraryLoads=false` with an empty `NSExceptionDomains`, so
      the vhost needs publicly-trusted TLS 1.2+ — Let's Encrypt via Caddy qualifies, and
      these same tills already reach `apiv2.lazywait.com` on this box. If a Windows till
      cannot, buy a commercial cert for this vhost rather than debugging the root store.
- [ ] **9.2 [HUMAN] Ship to the stores.** Attrition takes months; that is expected and
      costs only the B1 plan.
- [ ] **9.3 [AUTOMATED] Count DISTINCT DEVICES, not requests**, from the Caddy access log
      (`import accesslog`, step 6.2): `(deployment_key, app_version, client_unique_id,
      X-Legacy-Host)` all come off the query string with **no app code**. A handful of
      chatty retrying tills dominate a request count and would keep the App Service alive
      forever.
- [ ] **9.4 [HUMAN] Delete `codepushapp`** when distinct devices through the legacy host
      are ~0 for 30 days.
      Devices still polling a deleted host degrade benignly: `CodePushHttpError` →
      `checkForUpdate` rejects → `phase:'error'` → the POS runs its current bundle. No
      crash, no message, and the permanent-disable latch cannot fire (it gates on
      `appcenter.ms`).
  - *Rollback:* none, and this is the step that makes the accepted trade in the next
    section permanent.

---

## The trade you are signing, stated once

OTA lives in Azure UAE North today and is therefore independent of the Aliyun VPS. After
phase 9.4, the documented "apiv2 `ERR_CONNECTION_TIMED_OUT` = the merchant's source IP was
dropped at the Aliyun security group" failure takes down the POS API **and** the OTA
channel together — you lose the ability to hotfix precisely the sites that are broken.
Until 9.4, the App Service proxy is a second network path on a different cloud. Sign this
off consciously, in the ticket.

---

## Appendix A — container environment, and the five traps

| variable | value | why |
|---|---|---|
| `PORT` | `9002` | 9000 prod / 9001 dev are taken on this box |
| `SERVER_URL` | `https://codepush.lazywait.com` | **trap.** Left at the Azure value, `/auth/*` redirects developers back to Azure |
| `HTTPS` | **unset** | **trap.** `Boolean(process.env.HTTPS)` — `"false"` is truthy, and `api/.env`'s `HTTPS=true# …` keeps the whole string. Set it and the container dies reading `./certs/cert.key` |
| `UPLOAD_SIZE_LIMIT_MB` | `100` | default is 200; real bundles are ~30 MB raw. This number is the memory multiplier — multer buffers the upload |
| `REQUEST_TIMEOUT_IN_MILLISECONDS` | `300000` | **trap.** Default 120000 answers **408**; with Caddy at `read_timeout 300s` the app-level timeout is the binding constraint and Caddy's is decorative |
| `ENABLE_PACKAGE_DIFFING` | **set** (any truthy value) | **trap.** The guard is truthiness, so `ENABLE_PACKAGE_DIFFING=false` currently *enables* it. **Keep diffing ON.** Egress moves from Azure's free 100 GB/mo tier to a meter at the same moment; killing diffing multiplies bytes by ~7–26× on the day they start costing money |
| `DIFF_PACKAGE_COUNT` | `2` | default 5. This, not zero, is the release-time-CPU knob |
| `CODEPUSH_STORAGE_BACKEND` | unset at FLIP A, `supabase` at FLIP B | the whole of FLIP B |
| `CODEPUSH_METRICS_BACKEND` | unset at FLIP A, `supabase` at FLIP B | kills the Azure Redis line (~SR385/mo). Unset = the Redis manager, i.e. today's behaviour, so FLIP A still needs `REDIS_HOST`/`REDIS_PORT`/`REDIS_KEY`. Set = in-process response cache + `codepush_deployment_metric`, which needs migration 803 applied. Separate from the storage switch on purpose: either can be rolled back alone |
| `SUPABASE_URL` | project REST endpoint | |
| `SUPABASE_CODEPUSH_JWT` | the `codepush_api` token from P1 | **never** the service-role key |
| `SUPABASE_CODEPUSH_BUCKET` | `LazyWaitCodePush` | |
| `SUPABASE_CODEPUSH_PUBLIC_URL` | optional | public base for bundle URLs when it differs from `SUPABASE_URL` |
| `SUPABASE_CODEPUSH_APIKEY` (or `SUPABASE_ANON_KEY`) | the project's **anon** key | the `apikey` gateway header only — it identifies the PROJECT, not a role, and 803 revokes `anon` from every `codepush_*` table. Without it every request 401s as "Invalid API key", which reads like a bad JWT secret and is not |
| `SUPABASE_CODEPUSH_STORAGE_KEY` | **leave unset** | verified on a hosted project: the `codepush_api` JWT writes the bucket on its own (200, while anon is refused). This holds even though 803's storage GRANTs raise 42501 on Supabase Cloud — do **not** read those NOTICEs as needing a stronger key. Set this only to put bucket writes on a separately-rotated credential |
| `CORS_ORIGIN` | set explicitly | default is `http://localhost:4000`, and it echoes the first origin with `Allow-Credentials: true` to non-matching Origins |
| `APP_INSIGHTS_INSTRUMENTATION_KEY` | unset | the tracking router becomes a pass-through |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | unset | the last Azure identity dependency in the request path |
| `GIT_SHA` / `BUILD_TIME` | injected by CI `--build-arg` | what `/version` reports; `unknown` on a local run, which is itself the answer to "am I hitting my laptop?" |

`DEBUG_DISABLE_AUTH` is **not** an escape hatch: `auth.authenticate` is applied
unconditionally, outside the branch that would have mounted `passport.initialize()`. It
does not open the management API.

---

## Appendix B — what is already automated, and where it lives

| thing | state | path |
|---|---|---|
| Postgres schema | authored, **NOT applied** | `LazyWaitInternalAPI/supabase/migrations/803_codepush_core.sql` |
| Supabase storage backend | written, compiles, conformance-tested | `api/script/storage/supabase-storage.ts` |
| conformance harness | green on JsonStorage; Supabase leg gated | `api/test/storage-conformance.ts` |
| JWT minting + self-verification | written | `api/script/scripts/mint-codepush-jwt.ts` |
| read-only preflight (10 checks) | written | `api/script/scripts/verify-supabase-setup.ts` |
| Tier-1 single command | wired | `yarn test:tier1` (preflight → harness) |
| Azure export / Supabase import | written, **never run against prod by an agent** | `api/script/scripts/{export-azure,import-supabase}.ts` + its `README.md` |
| container image | written | `api/Dockerfile`, `.github/workflows/deploy.yml` |
| bucket creation | **[HUMAN]**, by design | phase 3.3 |
| GHCR poller + compose file | **[HUMAN]**, consumed by the VPS via `git pull` from THIS repo's `deploy/` | `deploy/poll-ghcr-codepush.sh`, `deploy/docker-compose.codepush.yml` |
| Caddy vhost | **[HUMAN]**, committed, bind-mounted | `deploy/vps/Caddyfile` in the Internal API repo |
| blob GC sweep | **not written** | phase 8.2 |

Gate the GHCR poller off release windows (rule 4). Model it on the **dev** poller, which
scopes `up -d` to one service — not the prod poller's whole-project `up -d`.

---

## Appendix C — abort matrix

| you are here | symptom | do this |
|---|---|---|
| any phase | P2 check 8 (anonymous blob read) is red | **stop.** Nothing flips until it is 200 |
| phase 4 | array-order check red | fix the adapter, never the assertion |
| phase 6 | tills stop getting updates | redeploy the old App Service zip; data plane untouched |
| phase 7, before the first new release | anything at all | `CODEPUSH_TAG=<old>`, unset `CODEPUSH_STORAGE_BACKEND`, `up -d` (~10 s) |
| phase 7, after the first new release | anything at all | rollback is **gone** (rule 5). Fix forward, non-mandatory releases only |
| phase 8 | a counter looks wrong | re-import metrics from the last export **with `--skip-metrics` on everything else** |
| phase 9 | a partner build points at Azure | it inherits `main`'s `strings.xml`; check the patcher stamped only the deployment key |
