# Authentication in this fork

Written at the Azure exit (design §C.6). It exists because "who is allowed to release
a bundle to the fleet" was previously spread across three passport providers, two of
which nobody used, and one debug flag that did not do what its name said.

---

## 1. What survives the rehost

**Two strategies, and only one of them matters at runtime.**

| Strategy | Registered | Used by | Configured with |
|---|---|---|---|
| `bearer` (`passport-http-bearer`) | **unconditionally**, in the `PassportAuthentication` constructor | **every** management API call | nothing — no env var, no external service |
| `github` (`passport-github2`) | only when `SERVER_URL` **and** `GITHUB_CLIENT_ID` **and** `GITHUB_CLIENT_SECRET` are all set | the interactive browser flow that mints a first access key | GitHub OAuth app |

**Removed:** `microsoft` (`passport-windowslive`) and `azure-ad` (`passport-azure-ad`).
They keyed off `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`, which are now read
nowhere; the packages are out of `package.json` and `package-lock.json` too. That was
the last Microsoft identity dependency in the request path — and, incidentally,
`passport-azure-ad` was what dragged `bunyan`, `node-jose`, `node-forge`, `moment`,
`lodash` and the native-compiled `dtrace-provider` into the image.

**Nothing rotates and nothing re-issues.** Removing an interactive provider cannot
invalidate a token, because a token is not issued by a provider: the browser flow
merely *ends* by calling the same `POST /accessKeys` path everything else uses. Every
existing CLI token, every developer's `%LOCALAPPDATA%\.code-push.config`, and the
dashboard proxy's `CODEPUSH_AUTH_TOKEN` keep working, across the storage cutover as
well (see §3).

### Which surfaces are authenticated at all

- `/updateCheck`, `/reportStatus/*` and their `/v0.1/public/codepush/*` twins — the
  **acquisition** surface the tills use — are **unauthenticated by design**. The
  deployment key in the query string is the credential. Auth never enters here.
- `/health`, `/version`, `/` — unauthenticated.
- `/auth/*`, `/accesskey` — unauthenticated (they are how you *get* a credential),
  rate-limited at 100 requests / 15 min.
- Everything else — the whole **management** API: apps, deployments, collaborators,
  release, promote, rollback, access keys — sits behind `auth.authenticate`.

---

## 2. Access keys: how they are minted and verified

### Minted

`POST /accessKeys` (`routes/management.ts:154-199`), authenticated like any other
management call — **you need a key to make a key**. The token value is
`security.generateSecureKey(accountId)` (`utils/security.ts:8-16`): 21 random bytes,
base64, made URL-safe, with the opaque account id concatenated on the end. A caller
may supply `name` instead and have their own value stored. Default TTL is **60 days**
(`DEFAULT_ACCESS_KEY_EXPIRY`, `management.ts:32`), overridable per request with `ttl`.

The interactive flow mints one too: after a successful GitHub callback,
`issueAccessKey` (`passport-authentication.ts`) creates a **session** key —
`isSession: true`, `friendlyName: "Login-" + Date.now()`, `createdBy` = the CLI's
`hostname` query parameter or `restHeaders.getIpAddress(req)` — and redirects to
`/accesskey`, which renders it once and clears the cookie session.

> **Known sharp edge, unfixed here:** that `friendlyName` has **no duplicate check**.
> On Azure it silently overwrote; against Postgres two logins in the same millisecond
> hit the `codepush_access_key_account_friendly_uidx` unique index. The Supabase
> backend's error mapper turns that 23505 into the route's intended conflict rather
> than a 500 — see `storage/supabase-storage.ts` and migration `803_codepush_core.sql`.

### Verified

The token is **never stored**. `sha256(token)` is
(`utils/common.ts:46-50` → `name_hash`). The bearer strategy takes the raw token off
the `Authorization` header, checks it against
`validationUtils.isValidKeyField` (10–100 chars, `^[a-zA-Z0-9_-]+$`), and calls
`storage.getAccountIdFromAccessKey(token)`, which hashes and looks the hash up.

Three outcomes, and they are deliberately distinct:

| Storage result | Response |
|---|---|
| hash not found | `401` — *"The session or access key being used is invalid…"* |
| found but `expires_at` in the past (`ErrorCode.Expired`) | `401` — *"…has expired…"* |
| anything else | `500` + `next(err)` |

Collapsing *expired* into *missing* turns an actionable message into a shrug; the
Supabase backend preserves the distinction on purpose.

**The hash is what makes the migration free.** `sha256(name)` is exactly what Azure
stored (`azure-storage.ts:1236-1239`), so `name_hash` and `expires` import verbatim
and no token has to be reissued. Nothing anywhere can recover a token from a hash —
including us. A lost token is re-minted, never recovered.

---

## 3. What a developer does after the rehost

### 3.1 Nothing, if they already have a token

`code-push-standalone` keeps working against the new host once it is pointed at it:

```
code-push-standalone login https://codepush.lazywait.com
```

Existing keys authenticate unchanged. Only the *server URL* moves.

### 3.2 If they need a fresh browser login — re-register the GitHub redirect URI

The callback URL is built as `${SERVER_URL}/auth/callback/github`
(`getCallbackUrl`). It is **not** configurable independently, and GitHub rejects any
callback that is not registered on the OAuth app. So the rehost needs, in this order:

1. `SERVER_URL=https://codepush.lazywait.com` in the container environment. Left
   pointing at Azure, the flow authenticates and then redirects the developer back to
   the *old* host.
2. On the GitHub OAuth app: add `https://codepush.lazywait.com/auth/callback/github`
   as an Authorization callback URL, and set the Homepage URL to
   `https://codepush.lazywait.com`. **Add, do not replace**, until the Azure App
   Service is retired — during FLIP A both hosts are live and both callbacks must
   resolve.
3. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` present. Miss any one of the three and
   the GitHub provider is simply not mounted: `/auth/login` still renders, and says
   no interactive provider is configured, rather than 404ing like a broken deploy.

### 3.3 Accounts that registered with Microsoft

Their account rows are untouched. The schema keeps `microsoft_id` / `azure_ad_id`,
`storage.Account` keeps `microsoftId` / `azureAdId`, and `converter.ts` still reports
`"Microsoft"` / `"AAD"` in `linkedProviders` — accurately, because those links still
exist. What is gone is the ability to *sign in* with them.

Such a developer has two paths, and the first is self-service:

- **Link GitHub to the existing account.** Accounts are keyed by **email**, and the
  `link` action looks the account up by the email the OAuth provider reports. If their
  GitHub account carries the same email address, `GET /auth/link?access_token=<token>`
  → *GitHub* writes `gitHubId` onto the existing account and every subsequent
  `/auth/login/github` works. Note the email must **match**; there is no merge.
- **Have an access key minted for them** by anyone already holding one, and skip the
  browser entirely.

If the live Azure App Service has `MICROSOFT_CLIENT_ID`/`_SECRET` genuinely populated
(they are empty in the committed `api/.env`, but the App Service reads its own app
settings, seeded from `codepush-infrastructure.bicep` parameters), confirm nobody is
mid-flight on that provider before the cutover. **A token holder is never affected
either way** — this is only about the browser sign-in.

### 3.4 `ADMIN_EMAILS` / `DEFAULT_APP_OWNERS` need a RESTART

Both are resolved from email to opaque account id **once, at router construction**
(`routes/management.ts:60-117`), so the per-request check is an account-id comparison
with no client-supplied value and no email-casing surface. The consequence is that
**editing either variable does nothing until the process restarts**, and adding an
email that has no account yet grants nothing (fail-closed, logged at startup as
`[admin-bypass] WARNING: could not resolve …`). Register the account first, then set
the variable, then restart — in that order.

Neither is set in `api/.env`.

---

## 4. `DEBUG_DISABLE_AUTH` — what it used to do, and what it does now

**It used to do nothing.** `auth.authenticate` was applied *below* the `if/else` in
`default-server.ts`, so with the flag set the impersonation middleware wrote
`req.user` and the bearer strategy overwrote it a microsecond later — or, with no
`Authorization` header, answered `401` before it got that far. Anyone who set the flag
concluded the *server* was broken.

(The mechanism usually blamed for this — `passport.initialize()` living inside the
router the debug branch never mounts — is **not** the cause. passport 0.6's
`authenticate()` installs the request extensions itself and short-circuits to the
supplied callback, so the bearer strategy runs fine without `initialize()`. The cause
was purely the placement of that one `app.use`.)

**Now it is real, and therefore fenced.** `auth.authenticate` moved inside the `else`
branch, so the flag genuinely bypasses authentication. Because a real bypass on this
server hands an anonymous caller the ability to push arbitrary JavaScript to every
till in the fleet, it is honoured only when **both** hold:

- `NODE_ENV` is not `production`, **and**
- `SERVER_URL` is unset or resolves to a loopback hostname (`localhost`, `127.x.x.x`,
  `::1`).

Anywhere else the process **refuses to start**, with a message naming both values. A
container that will not start is a bug report; a container that silently serves an
open management API is an incident. There is no way to force it — if you need
unauthenticated access to a deployed server, you do not need this flag, you need an
access key.

`DEBUG_USER_ID` names the account to impersonate; unset, it impersonates the literal
id `"default"`, which almost certainly does not exist and will 404 on `/account`.

---

## 5. Two known weaknesses. Recorded, deliberately NOT fixed here

Both are pre-existing, both are bounded by the single-replica deployment the design
already commits to, and both would be behaviour changes that belong in their own
change rather than smuggled into a provider removal.

### 5.1 Rate limits are per-process, and per-process only

`express-rate-limit` with its default **in-memory** store: 100 requests / 15 minutes,
keyed by IP.

- `passport-authentication.ts:30-33` — `/authenticated`, `/auth/login/github`,
  `/auth/register/github`, `/auth/link/github`, `/auth/callback/github`, `/accesskey`
- `management.ts:841-844` — `POST …/deployments/…/release`

`app.set("trust proxy", true)` is on (`server.ts:14`), so the key comes from
`X-Forwarded-For` — which is correct behind Caddy and forgeable if anything can reach
the container directly.

**The constraint this imposes: ONE replica.** Two replicas mean two independent
counters and an effective limit of 200/15min, silently. This is the *same*
single-replica constraint the acquisition response cache already imposes, so it costs
nothing today — but it is a second reason the answer to "can we scale it out?" is "not
without moving both of these to shared state first".

### 5.2 `getIpAddress` trusts the client, and the value is persisted

`utils/rest-headers.ts:29-40` reads, in order:

```
x-client-ip · x-forwarded-for · x-real-ip · x-cluster-client-ip ·
x-forwarded · forwarded-for · forwarded · socket.remoteAddress
```

Seven client-settable headers **before** the socket, first-wins, then `.split(",")[0]`.
Caddy sets `X-Forwarded-For`, but `X-Client-IP` — checked *first* — is set by nothing
in this deployment, so any caller can supply one and it wins.

That value lands in `AccessKey.createdBy` (`management.ts:161-163`, and the session-key
path in `passport-authentication.ts`), which is what the CLI's `code-push-standalone
access-key ls` prints as the key's origin. **Treat `createdBy` as a hint, never as
evidence.** It is not used for any authorization decision anywhere, which is why this
is a note and not a defect: the fix (read `req.ip`, or trim the list to the one header
the proxy actually sets) changes a persisted, user-visible field and should be its own
change.

### 5.3 `/auth/link` never checks the token it is handed

`GET /auth/link?access_token=…` writes the token into the cookie session
(`req.session["authorization"]`) and **nothing ever reads it back** — a grep for that
key across `script/` returns exactly the one write. The `link` branch of the OAuth
callback matches purely on the **email address the provider reports**.

So account linking is authenticated by control of a provider account carrying the
target email, not by possession of a CodePush token. That is upstream Microsoft
behaviour, it is unchanged by this work, and it is the mechanism §3.3 relies on — but
it means the security of linking rests entirely on the GitHub OAuth app's verified
email. Worth closing (read the session token, resolve it through
`getAccountIdFromAccessKey`, require it to match the resolved account) in a change of
its own.

---

## 6. If you are deleting more later

The design's phase 2 is to drop `passport`, `cookie-session`, the GitHub provider and
the EJS views entirely, and mint keys with a script. Until that happens:

- **The views must ship in the image.** `npm run build` is
  `tsc && shx cp -r ./script/views ./bin/script` (`package.json:11`); the Dockerfile
  has to preserve that copy or every `/auth/*` page 500s at render time.
- `authenticate.ejs` and the three `res.render("authenticate", …)` calls share a local
  variable list. EJS throws `ReferenceError` on an undefined local, so a variable
  removed from one **must** be removed from the other in the same change — that is why
  `isMicrosoftAuthenticationEnabled` is gone from both.
- `/accesskey` is registered inside `setupCommonRoutes`, i.e. **once per provider**.
  With three providers Express held three identical handlers and ran the first; with
  GitHub alone there is exactly one; with no provider configured it is not mounted at
  all — correctly, since nothing can then put a key in the session.
