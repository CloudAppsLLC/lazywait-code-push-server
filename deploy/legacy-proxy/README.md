# Legacy-URL proxy — FLIP A artifact

This is the thing that goes **on the Azure App Service** when the App Service stops
being the CodePush server. It is a pipe. It has no database, no storage, no auth, no
cache, no route table and **no dependency on any file under `../../api`**.

```
till on a 2023 store build
        |
        v
codepushapp-dvgsdugfg8d0a4f0.uaenorth-01.azurewebsites.net   (Azure App Service, B1)
        |   this proxy — stamps X-Legacy-Host: azure
        v
https://codepush.lazywait.com                                 (Caddy on the Aliyun VPS)
        |
        v
lazywait-codepush:9002                                        (the real server)
```

---

## Why the hostname cannot simply be retired

`codepushapp-dvgsdugfg8d0a4f0.uaenorth-01.azurewebsites.net` lives in **Microsoft's DNS
zone**. We do not own the record and cannot repoint it. It is compiled into every shipped
binary and read by the native layer at launch:

| Platform | File | Line |
|---|---|---|
| Android | `LazyWaitOne/android/app/src/main/res/values/strings.xml` | 9 |
| iOS | `LazyWaitOne/ios/lazywaitone/Info.plist` | 53-54 |
| Windows | `LazyWaitOne/windows/lazywaitone/lazywaitone.cpp` | 374 |
| Windows (paper) | `LazyWaitOne/windows.paper/lazywaitone/App.xaml.cs` | 145 |

JS can override the **deployment key** per call but never the server URL —
`LazyWaitUtil/src/CodePush/CodePush.js:102`, and `sync()`'s option bag has no `serverUrl`
at `:452`. **The last OTA bundle we ever serve from Azure cannot redirect anyone.** A
device only changes hostname by taking a new *store* build, which for some tills is never.

So the App Service survives, demoted from a server to ~200 lines of pipe.

---

## What actually crosses this process (and why B1 is enough)

**Bundle bytes do not.** An `update_check` response hands the device `download_url` as an
absolute URL pointing straight at object storage — `blobUrl`, or the diff's
`diffPackageMap[hash].url` (`api/script/utils/acquisition.ts:112-121`). Today that host is
Azure Blob Storage; after FLIP B it is Supabase Storage. Either way the ~13 MB gzipped
bundle is fetched from the **storage host directly**. It never traverses the CodePush
server, so it never traverses this proxy.

What does cross it:

| Traffic | Size | Frequency |
|---|---|---|
| `GET /v0.1/public/codepush/update_check` (and the legacy camelCase `/updateCheck`) | a few hundred bytes | once per app launch per till |
| `POST /v0.1/public/codepush/report_status/{deploy,download}` | one small JSON object | once per install / download |
| `GET /health` | tiny | pollers |
| management + `/auth/*` | small, **and should be zero** | see below |

Management traffic (`/apps/*`, `/accessKeys/*`) *should* stop arriving here the moment
`CODEPUSH_BASE_URL` moves — the CLI, `yarn release:*` and the ERP CodePush page all read
it. A developer with a stale `~/.code-push.config` (or `%LOCALAPPDATA%\.code-push.config`)
can still send a ~30 MB release upload through here. That single path is why the proxy
**streams** rather than buffers; it would otherwise put a 30 MB allocation on a 1.75 GB box.

**Azure's front end hard-closes any inbound request at 230 seconds** and there is no knob
for it on B1. `CODEPUSH_UPSTREAM_TIMEOUT_MS` (default 300000) therefore only guarantees the
proxy is never the component that gives up first — it cannot buy you more than 230s
end-to-end through the legacy hostname. Nothing on the acquisition path is anywhere near it.

---

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `CODEPUSH_UPSTREAM` | `https://codepush.lazywait.com` | Origin only, no path. Point it at `https://codepush-dev.lazywait.com` to rehearse. |
| `CODEPUSH_UPSTREAM_TIMEOUT_MS` | `300000` | Matches the Caddy vhost's `read_timeout`/`write_timeout 300s`. |
| `PORT` | `8080` | Injected by App Service; the default is only for a laptop. |

`GET /__legacy_proxy_health` is answered **locally**, without touching the upstream. It is
the one deliberate exception to "everything is proxied": `/health` is a real CodePush route
(`api/script/routes/acquisition.ts:166`) and is piped like everything else, so during the
soak a 502 from `/health` cannot tell you whether the proxy is dead or the VPS is
unreachable. `/__legacy_proxy_health` answers exactly that.

---

## Publish (FLIP A)

Modelled on the existing flow in `api/package.json` (`zip` → `az webapp deploy --type zip`).
The zip carries `bin/`, `package.json` and `.deployment`; Kudu runs `npm install` on the box
to materialise express. There is deliberately **no `build` script** in this `package.json` —
Oryx runs one automatically when it exists, and `src/` is not in the zip, so a build step
would fail the deployment. The TypeScript compile is called `compile` and runs on your
machine.

### 0. Prove the upstream first — do not skip this

```bash
# TLS, routing, and the real server, from off-network:
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://codepush.lazywait.com/health

# The response envelope, against a REAL deployment key. A 200 whose body has no
# `update_info` is silently "no update available" with no error anywhere
# (acquisition-sdk.js:77-80) — OTA would just stop, with no symptom.
curl -sS 'https://codepush.lazywait.com/v0.1/public/codepush/update_check?deployment_key=<REAL>&app_version=1.0.0&client_unique_id=preflight' | head -c 400
```

Also clear every outstanding **mandatory** release before flipping
(`LazyWaitOne/scripts/codepushRelease.js:639-677`, `clearStaleMandatoryReleases`) and make
the first post-cutover release non-mandatory, unconditionally. A *dead* server degrades
harmlessly; a *working* server handing out a broken `download_url` with `is_mandatory:true`
puts `CodePushBlocker` on the screen in a closed retry loop.

### 1. Record the state you are about to overwrite

```bash
RG=lazywait-code-push
APP=codepushapp

az webapp config appsettings list -g $RG -n $APP           > ./rollback/appsettings.json
az webapp config show            -g $RG -n $APP            > ./rollback/siteconfig.json
az webapp config show            -g $RG -n $APP --query appCommandLine -o tsv
az appservice plan list          -g $RG -o table            # note the plan NAME and its current SKU
az appservice plan show          -g $RG -n <plan> --query numberOfSites   # must be 1, see the B1 step
```

Keep a copy of the **real server's** deploy zip next to those files. That zip is the
rollback; build it now, while the tree is known-good:

```bash
cd ../../api && npm run build && npm run zip     # produces api/deploy.zip
```

### 2. Set the proxy's own app setting — and leave every other one alone

```bash
az webapp config appsettings set -g $RG -n $APP --settings \
  CODEPUSH_UPSTREAM=https://codepush.lazywait.com \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

**Do not delete `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_ACCESS_KEY` / the OAuth client
secrets.** The proxy ignores them; leaving them in place is what makes the rollback a
single `az webapp deploy` instead of a scavenger hunt for secrets under time pressure.
(Accepted trade: a storage-account key sits in the settings of a process that has no use
for it. Remove them at step 8 of the migration, when the Azure storage account is deleted
anyway.)

### 3. Publish

```bash
cd deploy/legacy-proxy
npm install
npm run deploy          # compile -> zip -> az webapp deploy --type zip
```

Then pin the startup command so it cannot depend on whatever Oryx infers:

```bash
az webapp config set -g $RG -n $APP --startup-file "node bin/server.js"
az webapp restart     -g $RG -n $APP
```

### 4. Verify through the legacy hostname

```bash
BASE=https://codepushapp-dvgsdugfg8d0a4f0.uaenorth-01.azurewebsites.net

curl -sS $BASE/__legacy_proxy_health                       # proxy alive, shows its upstream
curl -sS $BASE/health                                      # proxied — proves the VPS is reachable
curl -sS "$BASE/v0.1/public/codepush/update_check?deployment_key=<REAL>&app_version=1.0.0&client_unique_id=flipa-check"
```

The third call must return the **same envelope** the direct call returned in step 0. Then
confirm the stamp landed, on the VPS:

```bash
ssh <vps> "docker logs --tail 200 lazywait-caddy 2>&1 | grep -F 'X-Legacy-Host'"
```

If that greps nothing, read **"Retirement criteria"** below before assuming the proxy is
broken — the Caddy log snippet in use today deletes request headers.

### 5. Downgrade S1 → B1

Only after the soak has started and the proxy is confirmed serving.

```bash
az appservice plan update -g $RG -n <plan-name> --sku B1
```

Checks first, in order of how much they hurt when missed:

- **Is anything else on the plan?** `numberOfSites` from step 1. The SKU is a property of
  the *plan*, not the site — downgrading takes every app on it down a tier.
- **B1 has zero deployment slots** (S1 has 5). If a staging slot exists, it is destroyed.
- **Always On is available on B1**, so the app is not cold-started on every poll. Confirm
  it survived: `az webapp config show -g $RG -n $APP --query alwaysOn`.
- **B1 keeps custom domains and SNI TLS**, and the `*.azurewebsites.net` certificate is
  Microsoft-managed, so the hostname's TLS is unaffected.
- **Do not go to F1.** Free tier carries a daily CPU-minutes quota; when it trips, the site
  returns 403 for the rest of the day — a fleet-wide OTA outage on a billing rule.

---

## Rollback

The data plane is untouched by FLIP A, so rollback is one deployment. Both directions are
~2 minutes.

```bash
RG=lazywait-code-push
APP=codepushapp

# 1. Put the real server back.
az webapp deploy -g $RG -n $APP --src-path ../../api/deploy.zip --type zip

# 2. Restore the startup command you recorded in step 1 (usually `npm start`, i.e.
#    node ./bin/script/server.js). Do NOT leave it pointing at bin/server.js.
az webapp config set -g $RG -n $APP --startup-file "<recorded value>"

# 3. The app settings never changed, so there is nothing to restore. CODEPUSH_UPSTREAM
#    is simply ignored by the real server.
az webapp restart -g $RG -n $APP

# 4. If the plan was already downgraded and you want the headroom back:
az appservice plan update -g $RG -n <plan-name> --sku S1
```

**The plan SKU does not need to be reverted to roll back.** B1 ran the real server fine for
acquisition traffic; only concurrent release uploads would notice. Revert the code first,
worry about the SKU after.

`codepush.lazywait.com` can stay up throughout — a rolled-back App Service and a live VPS
container both reading the same Azure table is exactly the FLIP A steady state, in reverse.

---

## Retirement criteria — when may `codepushapp` be deleted?

**Count DISTINCT `client_unique_id` per `app_version`, over 30 days. Never request count.**
A handful of tills retrying a failed check produce thousands of requests and represent two
devices; a request count would keep this App Service alive forever for no reason, or (worse)
make a busy week look like a fleet.

**Delete `codepushapp` when the distinct-device count carrying `X-Legacy-Host: azure` has
been ~0 for 30 consecutive days.**

### The log the query runs against

`deploy/vps/Caddyfile` defines a shared `(accesslog)` snippet whose filter is
`request>headers delete` — it drops the **entire** request-header map, not a named subset.
That is correct for the API vhosts (those lines carried `Authorization: Bearer …` on every
dashboard call and grew a 25 GB log that filled the 40 GB root disk), and it is **wrong for
this one**: `X-Legacy-Host` is the whole retirement signal, and importing that snippet
deletes it before it is written. `wrap console` is not machine-readable either.

So `deploy/codepush-vhost.Caddyfile` does **not** import it. It carries its own `log`
directive inline — inline rather than a second shared snippet, because Caddy refuses to
start on an `import` of a snippet that has not been added to the target file, and a refusal
takes every other site on the box down with it. What it ships is:

```
	log {
		output stdout
		format filter {
			wrap json
			request>headers>Authorization delete
			request>headers>Cookie delete
			request>headers>Accept delete
			request>headers>Accept-Encoding delete
			resp_headers delete
		}
	}
```

Caddy's filter has no allow-list mode — you can only delete named fields — so the sensitive
ones go by name and the rest (including `X-Legacy-Host`) survive. `wrap json` is what makes
the query below a one-liner instead of a regex.

**If you edit that vhost, keep this property.** Swapping the block for a bare
`import accesslog` compiles, serves traffic correctly, and silently removes the only
evidence on which the App Service can ever be deleted.

### The query

Every field needed is in one record: the device id and app version are in the query string
(`api/script/routes/acquisition.ts` reads `client_unique_id` / `app_version`, with the
camelCase spellings still accepted for the old `/updateCheck` route), and the origin is the
header this proxy stamps. **No application code is involved** — the fork has no structured
logging.

```bash
# One day's distinct (app_version, device) pairs that arrived via the legacy hostname.
docker logs --since 24h lazywait-caddy 2>&1 \
| grep -F '"logger":"http.log.access"' \
| jq -r '
    select(.request.host == "codepush.lazywait.com")
  | select((.request.headers["X-Legacy-Host"] // [])[0] == "azure")
  | .request.uri
  | select(test("^/(v0\\.1/public/codepush/update_check|updateCheck)"))
  | (split("?")[1] // "")
  | split("&") | map(split("=")) | map({ (.[0]): (.[1] // "") }) | add
  | [ (.app_version // .appVersion // "unknown"),
      (.client_unique_id // .clientUniqueId // "unknown") ]
  | @tsv' \
| sort -u
```

`sort -u` on `(app_version, device)` pairs is the whole trick: it makes the daily output
**idempotent and unionable**, so a 30-day distinct count is the union of 30 daily files, not
a 30-day log retention problem.

### Retention — the part that bites

`docker logs` is bounded by the compose `logging` block (`json-file`, `max-size 50m`,
`max-file 3` — non-negotiable after the 25 GB Caddy log incident, `deploy/vps/disk-guard.sh:4-17`).
**150 MB of access log is nowhere near 30 days.** So snapshot daily and keep the small
distinct sets, not the logs:

```bash
# /opt/lazywait/legacy-codepush-tally.sh  — cron: 5 0 * * *
set -euo pipefail
OUT=/opt/lazywait/legacy-codepush
mkdir -p "$OUT"
docker logs --since 25h lazywait-caddy 2>&1 \
| grep -F '"logger":"http.log.access"' \
| jq -r '...as above...' \
| sort -u > "$OUT/$(date -u +%F).tsv"
find "$OUT" -name '*.tsv' -mtime +400 -delete
```

Then the actual decision number, any time:

```bash
# distinct devices per app_version over the last 30 days
cat $(ls -1 /opt/lazywait/legacy-codepush/*.tsv | tail -30) \
| sort -u | cut -f1 | uniq -c | sort -rn
```

Read it as: *"`1.4.7` still has 3 tills that only know the Azure hostname."* Three tills is
not zero. Zero for 30 days is the gate.

Two caveats, both real:

- **The stamp is forgeable.** Anyone can send `X-Legacy-Host: azure` straight to
  codepush.lazywait.com and inflate the count. It is a telemetry hint, not a security
  control; nothing is authorised by it. Worth knowing before someone treats a spike as fact.
- **A till that never launches is invisible.** A store closed for the season contributes
  zero and then reappears. 30 days is the compromise; a device that has been silent for a
  month has bigger problems than OTA.

---

## What a device does after `codepushapp` is finally deleted

Stated plainly, because this is the accepted end state and nobody should rediscover it
during an incident:

```
DNS/host gone
  -> the native SDK's request fails
  -> CodePushHttpError                       (acquisition-sdk.js:56-67)
  -> checkForUpdate REJECTS
  -> the store's catch branch sets phase:'error'   (codePushUpdateStore.ts:295-305)
  -> CodePushWrapper renders <WrappedApp/> anyway   (CodePushWrapper.tsx:141,145)
  -> the POS keeps running the bundle it already has
```

**No crash. No user-visible message. No blocking gate.** `INITIAL.isMandatory` is `false`
and the catch branch preserves only `available`/`pending`
(`codePushUpdateStore.ts:116-125`), so a dead server cannot raise the mandatory-update
blocker — only a *working* server handing out a broken `download_url` can do that. The
permanent-disable latch in the vendored SDK cannot fire either; it is gated on
`appcenter.ms` (`acquisition-sdk.js:16,27-31`).

The cost is exactly this: **those devices never receive another OTA update.** They are
frozen on their current bundle until someone installs a new store build on them. That is the
trade being accepted when the App Service is deleted, and it is why the gate is a distinct
*device* count and not a request count.

---

## Accepted trade, unrelated to this proxy but decided by it

OTA today lives in Azure UAE North and is therefore independent of the Aliyun VPS. Once this
proxy retires, an Aliyun security-group incident — the documented "apiv2
`ERR_CONNECTION_TIMED_OUT` = the merchant's source IP was dropped at the SG" failure — takes
down the POS API **and** the OTA channel together, removing the ability to hotfix precisely
the sites that are broken. For the 12–24 months this proxy exists, it is a second network
path on a different cloud. After that, it is a single point of failure. Sign that off
consciously.
