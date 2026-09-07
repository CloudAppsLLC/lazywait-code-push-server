# CodePush server — VPS deployment runbook

How this service is built, shipped and rolled back after it leaves Azure App
Service. Everything here is operator-facing; the design rationale lives in the
migration design doc.

---

## Architecture in one paragraph

CI builds `api/Dockerfile` and pushes it to
`ghcr.io/cloudappsllc/lazywait-code-push-server` as `:latest` **and**
`:<git-short-sha>`. GitHub Actions never touches the server — the Aliyun
security group in front of the VPS cannot allowlist GitHub's rotating egress
CIDRs. Instead a root cron entry on the box runs `poll-ghcr-codepush.sh` every
60 seconds; when the `:latest` digest changes it pulls and recreates the one
service. Caddy (owned by the Internal API stack, on the same host) terminates
TLS for `codepush.lazywait.com` and proxies to `codepush:9002` over the shared
docker network. The container binds `127.0.0.1:9002` only, so nothing reaches it
from the internet except through Caddy.

```
push to main ─► GH Actions ─► GHCR :latest + :sha
                                   │
                        (cron, 60s) ▼
  internet ─► Caddy :443 ─────► lazywait-codepush :9002 ─► Supabase (PostgREST + storage)
              (LazyWaitInternalAPI stack)
```

Ports already taken on this host: **9000** prod API, **9001** dev API. CodePush
owns **9002**.

> **A green CI run does not mean the server is running that build.** The box
> pulls; it is not pushed to. Confirm with
> `curl -sS https://codepush.lazywait.com/version` and compare `short_sha`
> against the commit. That distinction cost an afternoon in the sibling API repo
> before `/version` existed.

---

## 1. First-time setup

Everything below runs **as root on the VPS**, once.

### 1.1 Clone the repo

```bash
git clone https://github.com/CloudAppsLLC/lazywait-code-push-server.git /opt/lazywait-codepush
cd /opt/lazywait-codepush/deploy
```

The path matters: `poll-ghcr-codepush.sh` and `install-poller-codepush.sh`
default to `/opt/lazywait-codepush`. Use somewhere else and pass `INSTALL_DIR=`
/ `VPS_DIR=` to both.

### 1.2 GHCR credential

Already on the box for the API stack at `/opt/lazywait/.github_token`; the
poller re-asserts the login from it on every tick. Nothing to do unless that
file is missing, in which case create it with a classic PAT carrying
`read:packages` and `chmod 600` it.

### 1.3 Secrets — `deploy/.env.codepush`

Not committed (see `deploy/.gitignore`). Create it beside the compose file:

```bash
umask 077
cat > /opt/lazywait-codepush/deploy/.env.codepush <<'EOF'
# ── data layer ───────────────────────────────────────────────────────────────
# FLIP A leaves this UNSET: the container runs the existing AzureStorage backend
# against the same table and blobs as the App Service, so only the network
# changed. FLIP B sets it to `supabase` and nothing else changes. Reverting FLIP
# B is removing this one line plus a restart.
CODEPUSH_STORAGE_BACKEND=supabase

SUPABASE_URL=https://<project-ref>.supabase.co
# A PostgREST JWT signed with the project JWT secret carrying
# {"role":"codepush_api"} — NOT the service-role key. The scoped role is created
# by migration 803 and granted only the codepush_* objects. Handing this fork
# the service-role key would give it pos_orders and hrms_employees.
SUPABASE_CODEPUSH_JWT=

# REQUIRED. The project's ANON key, and it rides ONE header: `apikey`.
#
# Supabase Cloud wants two different credentials on two headers -- `apikey`
# identifies the PROJECT to the gateway and must be a key the project itself
# issued; `Authorization` identifies the ROLE. `new SupabaseClient(url, jwt)`
# puts the same value in both, so passing the codepush_api JWT there is rejected
# at the edge with {"message":"Invalid API key","hint":"Double check your
# Supabase `anon` or `service_role` API key."} -- an error that accuses the JWT
# secret, which is the one thing it is not.
#
# It authorises nothing: 803 revokes anon from all nine codepush_* tables. The
# adapter throws at boot if this is missing.
SUPABASE_CODEPUSH_APIKEY=

# LEAVE THIS EMPTY. Verified against a hosted project: the codepush_api JWT
# above writes the bucket on its own (POST /object -> 200, while the anon key is
# refused). That holds EVEN THOUGH 803's storage-schema GRANTs raise 42501 on
# Supabase Cloud, where `supabase_storage_admin` is a reserved role -- do not
# read those NOTICEs as needing a stronger key. The only thing the missing grants
# cost is reading the BUCKET ROW (`GET /storage/v1/bucket/<name>`), which nothing
# in the request path does. Set this only to put uploads on a separately-rotated
# credential.
SUPABASE_CODEPUSH_STORAGE_KEY=
SUPABASE_CODEPUSH_BUCKET=LazyWaitCodePush

# Azure — keep these for FLIP A and for the two-week rollback window, then
# delete them along with the storage account.
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_ACCESS_KEY=

# ── cache + deployment metrics ───────────────────────────────────────────────
# A SEPARATE SWITCH FROM THE ONE ABOVE, on purpose: either half can be rolled
# back alone. Unset (FLIP A) = the Azure Redis manager, byte for byte today's
# behaviour. `supabase` (FLIP B) = in-process response cache + the
# codepush_deployment_metric table, which needs migration 803 applied.
CODEPUSH_METRICS_BACKEND=supabase

# DO NOT SKIP THESE AT FLIP A. RedisManager degrades SILENTLY when they are
# absent: one "No REDIS_HOST or REDIS_PORT environment variable configured."
# line at boot, then every method resolves as a no-op. The response cache is
# gone (every update check falls through to the Azure table) and — the part
# that cannot be undone — deployment metrics stop being recorded, with Redis
# being the only copy that ever existed. A 7-day soak run this way looks
# perfectly healthy and quietly loses the week's Active/Downloaded counts.
# Delete these three at FLIP B, together with the Azure block above.
REDIS_HOST=
REDIS_PORT=6380
REDIS_KEY=

# ── server identity ──────────────────────────────────────────────────────────
# Used to build the OAuth callback URLs. Leave it pointing at Azure and the
# /auth/* flow bounces developers back to the App Service.
SERVER_URL=https://codepush.lazywait.com
# Explicit, because the default is http://localhost:4000 AND the headers
# middleware echoes the first configured origin with Allow-Credentials: true to
# non-matching Origins.
CORS_ORIGIN=https://lazywait.com

# ── auth ─────────────────────────────────────────────────────────────────────
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
# MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET are deliberately absent: unset,
# both the `microsoft` and `azure-ad` providers disappear, which removes the
# last Azure identity dependency from the request path.

# ── release behaviour ────────────────────────────────────────────────────────
# Diffing stays ON. The guard is truthiness, so `false` here would ENABLE it
# anyway — write `true` and mean it. Turning diffing off multiplies download
# egress by roughly 7-26x, on a bucket that is metered per GB, which is the
# opposite of the point of this migration.
ENABLE_PACKAGE_DIFFING=true
# Cap release-time CPU by generating fewer diffs, not by disabling them.
# Default is 5.
DIFF_PACKAGE_COUNT=2
EOF
```

**Do not add `HTTPS` to this file, with any value.** `server.ts` reads it as
`Boolean(process.env.HTTPS)`, so the string `"false"` is true — and `api/.env`'s
own `HTTPS=true# Set to 'true'…` is kept whole by dotenv because no space
precedes the `#`. Any value makes the process read `./certs/cert.key` at boot
and exit. Caddy terminates TLS.

`PORT`, `UPLOAD_SIZE_LIMIT_MB` and `REQUEST_TIMEOUT_IN_MILLISECONDS` are set in
the compose file, not here, so they stay visible next to the port they publish
and the proxy timeout they must match.

### 1.4 DNS

`codepush.lazywait.com` → `8.213.81.231` (A record). **Before** Caddy loads the
vhost, or the ACME HTTP-01 challenge fails and Caddy retries every minute
serving nothing on that name. Other sites are unaffected while it retries.

### 1.5 The Caddy vhost

`deploy/codepush-vhost.Caddyfile` is a fragment, not a live config. Paste it
into **`deploy/vps/Caddyfile` in the LazyWaitInternalAPI repo**, commit, push,
then `git pull` in `/opt/lazywait`. The Caddy container bind-mounts that file
from the checkout, so an edit made on the server is wiped by the next pull —
that has already destroyed the `apiv2-dev` vhost once, taking its certificate
with it. Then:

```bash
docker exec lazywait-caddy caddy reload --config /etc/caddy/Caddyfile
```

### 1.6 Start it

```bash
cd /opt/lazywait-codepush/deploy
docker compose -f docker-compose.codepush.yml up -d
docker compose -f docker-compose.codepush.yml ps
curl -sS http://127.0.0.1:9002/health
curl -sS http://127.0.0.1:9002/version
```

The compose file attaches to the **external** network `lazywait_lazywait`, which
the API stack creates. If it does not exist yet, start the API stack first —
this project must never create it, or a `down` here would take the prod API's
network with it.

### 1.7 Install the poller

```bash
sudo bash /opt/lazywait-codepush/deploy/install-poller-codepush.sh
tail -f /var/log/lazywait-deploy/poll-codepush.log
```

Logs land in the same directory as the two API pollers, which is already covered
by `/etc/logrotate.d/lazywait-deploy`. The installer warns if that rule is
missing — an uncapped log on this box has form (a 25 GB Caddy log filled the
40 GB root disk and pinned both vCPUs).

---

## 2. How a change reaches production

1. Merge to `main`.
2. `.github/workflows/deploy.yml` builds `api/Dockerfile` and pushes
   `:latest` + `:<short-sha>` with `GIT_SHA` / `BUILD_TIME` baked in.
3. Within ~60s the poller sees the new digest, pulls, and runs
   `docker compose up -d codepush` — **one service only**, never the whole
   project and never `--remove-orphans`.
4. It probes `/health` and logs `/version`. That log line is the proof the swap
   happened.

Commits touching only `**.md`, `deploy/**` or the CodeQL workflow do **not**
build. That is not about CI minutes: a new digest means a container restart, and
a restart empties the in-process update-check cache, sending the whole fleet's
next check to the database at once.

### Pausing deploys around a release

A restart mid-release destroys the temp file the upload is streaming through and
flushes the response cache exactly when the fleet is about to ask for the new
bundle. Before a release window:

```bash
touch /opt/lazywait-codepush/deploy/.deploy-hold
# ... run the release ...
rm /opt/lazywait-codepush/deploy/.deploy-hold
```

The poller logs a `HOLD:` line on every skipped tick, so a hold left in place is
visible rather than silent.

---

## 3. Rollback

Two independent things can be rolled back, and they are not the same operation.

### 3.1 Roll back the IMAGE (a bad build)

```bash
cd /opt/lazywait-codepush/deploy
echo 'CODEPUSH_TAG=a3f9c12' > .env          # a previous short-sha from GHCR
docker compose -f docker-compose.codepush.yml up -d codepush
curl -sS http://127.0.0.1:9002/version      # confirm short_sha
```

`.env` in that directory is read by `docker compose` for variable substitution
and is gitignored, so the pin is host-local and survives a `git pull`. **The
poller respects it**: while the resolved image is not `:latest`, it logs
`PINNED:` and does nothing, so the next tick cannot drag the box back onto the
broken build. Return to auto-deploys by deleting `.env` (or setting
`CODEPUSH_TAG=latest`) and running `up -d` once.

### 3.2 Roll back the DATA LAYER (FLIP B)

Remove `CODEPUSH_STORAGE_BACKEND=supabase` from `.env.codepush` and
`up -d codepush`. The process is back on the Azure table and blobs in about ten
seconds; the network path, the hostname and the TLS certificate are untouched
because they were moved in a separate, earlier flip.

**This stops being safe the moment a release lands in Postgres only.** Azure's
package history has never seen that release, so a till reporting the new hash
finds no match, the newest *Azure* package looks different from what it is
running, and the fleet is offered a downgrade — mandatory, if any pre-cutover
release still carries `-m`. Either keep releases frozen for the whole rollback
window, or declare the data rollback unavailable after the first post-cutover
release. Decide which, in writing, before the flip.

---

## 4. Operations

```bash
cd /opt/lazywait-codepush/deploy
docker compose -f docker-compose.codepush.yml logs -f codepush
docker compose -f docker-compose.codepush.yml ps
docker stats lazywait-codepush --no-stream
tail -f /var/log/lazywait-deploy/poll-codepush.log
bash /opt/lazywait-codepush/deploy/poll-ghcr-codepush.sh   # force a check now
```

**Endpoints**

| URL | What it tells you |
|---|---|
| `/health` | Storage backend reachable, plus the metrics backend when one is configured. `Healthy` is the body with `CODEPUSH_METRICS_BACKEND=supabase` (the `codepush_deployment_metric` probe ran and passed); `Healthy (no cache configured)` means no metrics backend at all — healthy by design. A *configured but unreachable* one still fails. |
| `/version` | `sha`, `short_sha`, `built_at`, `storage_backend`, `uptime_seconds`. Answers "which build is live" and "which flip are we on". |

**Resource ceilings.** `mem_limit: 2g`, `cpus: 0.5`. The memory figure is sized,
not guessed: a single release holds the multer memory buffer, the temp file, the
zip manifest walk and the upload body concurrently, so at
`UPLOAD_SIZE_LIMIT_MB=100` the spike is ~400 MB above steady state. If releases
start getting OOM-killed, lower `UPLOAD_SIZE_LIMIT_MB` before raising
`mem_limit` — the limit is the multiplier.

**Never scale this service past one replica.** The update-check response cache,
the express-rate-limit counters and the release temp file are all in-process. A
second replica silently serves a stale `update_check` for up to an hour after a
release, which on this fleet means tills that never see a hotfix.

---

## 5. Troubleshooting

| Symptom | Cause |
|---|---|
| Container exits at boot reading `./certs/cert.key` | `HTTPS` is set to *something* in `.env.codepush`. Any value is truthy. Remove the line. |
| Caddy 502 on `codepush.lazywait.com` | Container down, or it is not on the `lazywait_lazywait` network. `docker network inspect lazywait_lazywait` should list `lazywait-codepush`. |
| Caddy fails to start after pasting the vhost | `import accesslog` refers to a snippet defined at the top of the API repo's `Caddyfile`. Caddy refuses to start on an undefined snippet import. |
| ACME retries forever, no cert | DNS for `codepush.lazywait.com` does not resolve to this VPS yet. |
| `/version` reports an old `short_sha` after a green CI run | The poller did not run or did not act: check for `.deploy-hold`, a `PINNED:` line, or a stale GHCR login in `poll-codepush.log`. |
| Container shows `(unhealthy)` but serves 200s | Should not happen here — the healthcheck uses node, not `wget`. If someone "fixes" it to `wget`/`curl` it will break permanently: neither binary exists in `node:slim`. That is exactly why the prod API container has reported unhealthy for months. |
| Large release fails mid-upload with a socket error | Caddy's `request_body max_size` (120MB) must stay strictly above `UPLOAD_SIZE_LIMIT_MB` (100). If they cross, the proxy truncates the body instead of the app returning a readable error. |
| A release takes >2 min and 408s | `REQUEST_TIMEOUT_IN_MILLISECONDS` is back at its 120000 default. It must be ≥ Caddy's 300s, or the app timeout is the binding constraint and the proxy's is decoration. |
| Fleet suddenly hammers the database | Someone restarted the container. The response cache is in-process; a restart is a full flush. Do not restart during a rollout. |

---

## 6. What this replaces

`api/package.json`'s `deploy` script — `npm run build && npm run zip && az webapp
deploy --name codepushapp --resource-group lazywait-code-push` — is the old path.
It is left in place on purpose while the Azure App Service is still serving the
baked-in `codepushapp-…azurewebsites.net` hostname that every shipped binary
carries and that cannot be repointed. Do not delete it until that App Service is
retired on distinct-device evidence from the Caddy access log
(`count(distinct client_unique_id)` per `app_version`, not request volume).
