// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// =============================================================================
// verify-supabase-setup.ts  --  READ-ONLY preflight for the CodePush rehost
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Migration 803 creates nine tables, a scoped `codepush_api` role, two RPCs, a
// bucket and four storage policies. Applying it is a HUMAN act, and a human act
// has partial outcomes: 803 downgrades two of its own GRANTs to a NOTICE when a
// role is absent, the bucket is created BY HAND (deliberately -- bucket creation
// is a project-level act and `storage.buckets` ownership differs across Supabase
// versions), and the whole file is re-runnable, which means it can also have
// been half-run. None of those partial states announce themselves. They surface
// as an opaque 500 from a route that has nothing to do with the thing that is
// actually missing.
//
// So: one command that answers, line by line, "is this project ready to serve
// CodePush", against dev and against prod, before anything is flipped.
//
// THE ONE CHECK THAT MATTERS MOST IS #8
// -------------------------------------
// "an object under blobs/ is readable ANONYMOUSLY, with no auth header."
//
// If that is wrong, a MANDATORY release bricks tills, and there is no OTA path
// to the fix because the OTA channel is the thing that is broken:
//   update_check 200s with is_mandatory -> isMandatoryBlocking() -> CodePushBlocker
//   owns the screen (CodePushWrapper.tsx:141-159) -> installCodePushUpdate ->
//   the bundle download 403s -> SyncStatus.UNKNOWN_ERROR -> phase 'error', which
//   is DELIBERATELY inside isMandatoryBlocking (codePushUpdateStore.ts:102-114)
//   -> the gate stays up, the only button is Retry, and relaunch re-enters the
//   same loop. onDevDismiss is undefined in release builds.
// A dead server does NOT do this (INITIAL.isMandatory is false, so a failed
// check degrades to a running POS). A WORKING server handing out a broken
// download URL does. Which is why this check downloads nothing and asserts
// nothing about the schema: it makes the exact request a till in a shop makes.
//
// IT MUTATES NOTHING, AND THAT IS A DESIGN CONSTRAINT, NOT A HOPE
// ----------------------------------------------------------------
// Every check below is a read, with two stated exceptions, both of which are
// non-mutating BY CONSTRUCTION rather than by convention:
//
//   * check 5 calls `codepush_bump_metrics` with an EMPTY array. The function
//     body is `FOR e IN SELECT * FROM jsonb_array_elements(p_entries) LOOP`, so
//     with `[]` the loop never executes. It proves the function exists, its
//     signature matches, and this role may EXECUTE it -- and writes nothing.
//
//   * check 6 calls `codepush_commit_package` with a deployment id that cannot
//     exist. Its first statement is `UPDATE codepush_deployment ... WHERE id = $1
//     RETURNING label_counter`, which matches no row, so `v_seq` is NULL and the
//     function RAISEs `no_data_found` before the INSERT. PostgREST runs every
//     request in a transaction, so the RAISE rolls the whole thing back -- the
//     label_counter increment included. There is no input to this function that
//     is both non-mutating and successful, so the ERROR is the pass condition,
//     and the check asserts on WHICH error: "not found" means the RPC is there
//     and callable; "function does not exist" means 803 was not applied.
//
//   * check 9 (anon write, opt-in on a supplied anon key) is the one probe that
//     WOULD write if the setup is wrong -- that is the finding. It writes under
//     `preflight/`, never `blobs/`, so even a successful (i.e. failing) probe
//     cannot shadow a bundle the fleet downloads, and it deletes what it wrote
//     and prints the exact path if it cannot.
//
// Nothing here reads `api/.env`. That file is committed, points at Azure and
// holds credentials that must not be used; requiring the variables explicitly is
// what stops this script from silently probing the wrong system.
//
// USAGE
// -----
//   cd api
//   yarn build
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_CODEPUSH_JWT=<codepush_api jwt from mint-codepush-jwt.ts> \
//     node bin/script/scripts/verify-supabase-setup.js
//
// | flag | effect |
// |---|---|
// | `--blob <id>` | check 8 against this blob id instead of discovering one |
// | `--anon-key <jwt>` | run checks 9-10 with this tenant/anon credential |
// | `--skip-anon-write` | skip check 9 (the only probe that could write) |
// | `--strict` | a SKIP is a failure -- use this at the cutover gate |
// | `--conformance` | on an all-green preflight, run the storage conformance harness |
// | `--json` | machine-readable summary on stdout (human report stays on stderr) |
//
// | env | used for |
// |---|---|
// | `SUPABASE_URL` | required |
// | `SUPABASE_CODEPUSH_JWT` | required -- the `codepush_api` token |
// | `SUPABASE_CODEPUSH_BUCKET` | default `LazyWaitCodePush` |
// | `SUPABASE_CODEPUSH_PUBLIC_URL` | public base for bundle reads, default `SUPABASE_URL` |
// | `SUPABASE_CODEPUSH_STORAGE_KEY` | optional separate storage credential |
// | `SUPABASE_ANON_KEY` | optional; enables checks 9-10 without `--anon-key` |
// | `SUPABASE_SERVICE_ROLE_KEY` | optional; ONLY read bucket metadata when the scoped role cannot |
// | `CODEPUSH_PROD_SUPABASE_URL` | if set and equal to the target, `--conformance` REFUSES |
//
// Those names are SupabaseStorage's contract (script/storage/supabase-storage.ts),
// deliberately reused verbatim: a preflight that reads different variables than
// the server reads can be green against a project the server never talks to.
//
// EXIT CODES: 0 everything checked passed; 1 at least one FAIL (or, under
// `--strict`, at least one SKIP); 2 the script could not be configured at all.
// =============================================================================

import * as childProcess from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

const TOOL = "verify-supabase-setup";

const ENV_URL = "SUPABASE_URL";
const ENV_JWT = "SUPABASE_CODEPUSH_JWT";
const ENV_API_KEY = "SUPABASE_CODEPUSH_APIKEY";
const ENV_API_KEY_FALLBACK = "SUPABASE_ANON_KEY";

/**
 * The project's anon key, sent ONLY as the `apikey` gateway header. See
 * authHeaders() below for why this is a separate credential from the token.
 * Resolved once at module load so every check uses the same value.
 */
const PROJECT_API_KEY: string = process.env[ENV_API_KEY] || process.env[ENV_API_KEY_FALLBACK] || "";
const ENV_BUCKET = "SUPABASE_CODEPUSH_BUCKET";
const ENV_PUBLIC_URL = "SUPABASE_CODEPUSH_PUBLIC_URL";
const ENV_STORAGE_KEY = "SUPABASE_CODEPUSH_STORAGE_KEY";
const ENV_ANON_KEY = "SUPABASE_ANON_KEY";
const ENV_SERVICE_ROLE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const ENV_PROD_URL = "CODEPUSH_PROD_SUPABASE_URL";

const DEFAULT_BUCKET = "LazyWaitCodePush";
const EXPECTED_ROLE = "codepush_api";
const BLOB_PREFIX = "blobs";

// The nine tables 803 creates. Kept as a literal list rather than derived from
// anything: this file's job is to assert the schema, so it must carry its own
// idea of what the schema is.
const TABLES: string[] = [
  "codepush_account",
  "codepush_app",
  "codepush_app_collaborator",
  "codepush_deployment",
  "codepush_package",
  "codepush_package_diff_blob",
  "codepush_access_key",
  "codepush_blob",
  "codepush_deployment_metric",
];

// UPLOAD_SIZE_LIMIT_MB is 100 on the container, so a bucket ceiling below that
// turns a legitimate release into a 413 at the worst possible moment. Real
// bundles measure ~30 MB raw (the LazyWaitOne index.android.bundle is
// 29,579,532 bytes), so 100 MB is headroom, not a target.
const REQUIRED_BUCKET_BYTES = 100 * 1024 * 1024;

// The design's rule for check 8: rehearse the fleet's download against an object
// big enough to be a real bundle. A tiny probe object can pass while a 50 MB one
// trips a proxy or a range limit.
const PREFERRED_BLOB_BYTES = 50 * 1024 * 1024;

type Status = "PASS" | "FAIL" | "SKIP" | "WARN";

interface CheckResult {
  id: string;
  title: string;
  status: Status;
  detail: string;
}

interface Flags {
  blobId: string;
  anonKey: string;
  skipAnonWrite: boolean;
  strict: boolean;
  conformance: boolean;
  json: boolean;
}

interface Config {
  url: string;
  jwt: string;
  bucket: string;
  publicUrl: string;
  storageKey: string;
  serviceRoleKey: string;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const results: CheckResult[] = [];

// The report goes to stderr so `--json` owns stdout.
function say(message: string): void {
  console.error(message);
}

function record(id: string, title: string, status: Status, detail: string): CheckResult {
  const result: CheckResult = { id, title, status, detail };
  results.push(result);
  const marker: string = status === "PASS" ? "ok  " : status === "FAIL" ? "FAIL" : status === "WARN" ? "warn" : "skip";
  say(`  ${marker}  ${id}. ${title}`);
  if (detail) {
    detail.split("\n").forEach((line: string) => say(`          ${line}`));
  }
  return result;
}

// ── argv / config ────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    blobId: "",
    anonKey: process.env[ENV_ANON_KEY] || "",
    skipAnonWrite: false,
    strict: false,
    conformance: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg: string = argv[i];
    switch (arg) {
      case "--blob":
        flags.blobId = argv[++i];
        break;
      case "--anon-key":
        flags.anonKey = argv[++i];
        break;
      case "--skip-anon-write":
        flags.skipAnonWrite = true;
        break;
      case "--strict":
        flags.strict = true;
        break;
      case "--conformance":
        flags.conformance = true;
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        say(`[${TOOL}] ERROR unknown flag '${arg}'. See the header of this file for usage.`);
        process.exit(2);
    }
  }

  return flags;
}

function resolveConfig(): Config {
  const url: string = (process.env[ENV_URL] || "").replace(/\/+$/, "");
  const jwt: string = process.env[ENV_JWT] || "";

  if (!url || !jwt) {
    say(
      `[${TOOL}] ERROR ${ENV_URL} and ${ENV_JWT} are both required.\n` +
        `        Mint the JWT with:  node bin/script/scripts/mint-codepush-jwt.js\n` +
        `        Do NOT substitute the service-role key -- see migration 803, "ACCESS: NOT service_role".`
    );
    process.exit(2);
  }

  if (!PROJECT_API_KEY) {
    say(
      `[${TOOL}] ERROR ${ENV_API_KEY} (or ${ENV_API_KEY_FALLBACK}) is required.\n` +
        `        It is the project's ANON key and is sent ONLY as the 'apikey' gateway header --\n` +
        `        the header that identifies the PROJECT. It authorises nothing: 803 revokes anon\n` +
        `        from every codepush_* table. Without it every request 401s as "Invalid API key",\n` +
        `        a message that blames the JWT secret rather than the missing routing header.`
    );
    process.exit(2);
  }

  return {
    url,
    jwt,
    bucket: process.env[ENV_BUCKET] || DEFAULT_BUCKET,
    publicUrl: (process.env[ENV_PUBLIC_URL] || url).replace(/\/+$/, ""),
    storageKey: process.env[ENV_STORAGE_KEY] || "",
    serviceRoleKey: process.env[ENV_SERVICE_ROLE_KEY] || "",
  };
}

// ── http ─────────────────────────────────────────────────────────────────────

// A transport failure is a RESULT here, not an exception. One unreachable host
// -- a DNS miss on SUPABASE_CODEPUSH_PUBLIC_URL, a proxy refusing CONNECT --
// must fail its own line and leave the other nine reported, because "which of
// the ten is broken" is the entire output of this script. A throw would collapse
// the report to a stack trace.
async function httpRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<HttpResponse> {
  try {
    return await rawRequest(method, url, headers, body);
  } catch (reason) {
    // Name AND code AND message: a bare `.message` is empty for several of
    // Node's socket errors, and "transport error: " with nothing after it is the
    // least useful line this script could print.
    const error = reason as NodeJS.ErrnoException;
    const described: string = [error && error.code, error && error.name, error && error.message].filter(Boolean).join(" ") || String(reason);
    return { status: 0, headers: {}, body: Buffer.from(`transport error: ${described} (${new URL(url).host})`, "utf8") };
  }
}

function rawRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const parsed: URL = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const request = transport.request(
      {
        method,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        headers: body ? { ...headers, "Content-Length": String(body.length) } : headers,
      },
      (response: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

/**
 * TWO HEADERS, TWO DIFFERENT CREDENTIALS.
 *
 * `apikey` is the Supabase gateway's PROJECT router and must be one of the
 * project's own issued keys (anon / service_role). A self-signed `codepush_api`
 * JWT is not, so sending it there is rejected at the edge -- before PostgREST,
 * before any role, grant or policy is consulted -- with
 *   {"message":"Invalid API key","hint":"Double check your Supabase `anon` or
 *    `service_role` API key."}
 * That message accuses the JWT secret, which is the one thing it is not. A
 * perfectly correct token failed this way.
 *
 * The anon key authorises NOTHING here: 803 revokes anon from every codepush_*
 * table, so this is a routing credential, not a widening of access.
 */
function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: PROJECT_API_KEY,
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(extra || {}),
  };
}

function snippet(response: HttpResponse): string {
  return response.body.toString("utf8").replace(/\s+/g, " ").slice(0, 220);
}

// ── checks ───────────────────────────────────────────────────────────────────

// 1. The token, read locally. This runs before any network call because the two
// ways to get this wrong are both silent: a service-role key pasted into
// SUPABASE_CODEPUSH_JWT passes every other check in this file with flying
// colours while handing the fork the whole database, and an anon key fails
// checks 2-6 in a way that reads like "the migration is missing".
function checkTokenClaims(config: Config): void {
  const segments: string[] = config.jwt.split(".");
  if (segments.length !== 3) {
    record("1", "JWT is well-formed and carries role=" + EXPECTED_ROLE, "FAIL", `${ENV_JWT} has ${segments.length} segments, not 3`);
    return;
  }

  let claims: Record<string, string | number>;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch (reason) {
    record("1", "JWT is well-formed and carries role=" + EXPECTED_ROLE, "FAIL", "the payload segment is not JSON");
    return;
  }

  const role: string = String(claims.role || "");
  const expiresAt: number = Number(claims.exp || 0);
  const expiry: string = expiresAt ? new Date(expiresAt * 1000).toISOString() : "(no exp claim)";

  if (role === "service_role") {
    record(
      "1",
      "JWT is well-formed and carries role=" + EXPECTED_ROLE,
      "FAIL",
      `role='service_role'. STOP. That credential bypasses RLS on every table in the project --\n` +
        `pos_orders, hrms_employees, platform_support_access_log. The whole point of 803's scoped\n` +
        `role is that this container cannot reach them. Mint a ${EXPECTED_ROLE} token instead.`
    );
    return;
  }

  if (role !== EXPECTED_ROLE) {
    record("1", "JWT is well-formed and carries role=" + EXPECTED_ROLE, "FAIL", `role='${role || "(absent)"}', expected '${EXPECTED_ROLE}'`);
    return;
  }

  if (expiresAt && expiresAt * 1000 < Date.now()) {
    record("1", "JWT is well-formed and carries role=" + EXPECTED_ROLE, "FAIL", `the token EXPIRED at ${expiry}`);
    return;
  }

  const daysLeft: number = expiresAt ? Math.floor((expiresAt * 1000 - Date.now()) / 86400000) : 0;
  if (expiresAt && daysLeft < 90) {
    record("1", "JWT is well-formed and carries role=" + EXPECTED_ROLE, "WARN", `role=${role}, but it expires in ${daysLeft} day(s), at ${expiry}`);
    return;
  }

  record("1", "JWT is well-formed and carries role=" + EXPECTED_ROLE, "PASS", `role=${role}, expires ${expiry}`);
}

// 2. The same token, through the project. A 200 here proves four separate things
// at once and each failure mode names a different file: the signature is
// accepted (the secret is the project's), `authenticator` is a MEMBER of
// codepush_api so PostgREST's per-request SET ROLE succeeded, the GRANT exists,
// and the *_svc_all policy lets the role past 803's own deny-all.
async function checkPostgrestAcceptsToken(config: Config): Promise<boolean> {
  const response: HttpResponse = await httpRequest("GET", `${config.url}/rest/v1/codepush_account?select=*&limit=0`, authHeaders(config.jwt));

  if (response.status === 200) {
    record("2", "PostgREST accepts the JWT and resolves it to a role that can read", "PASS", `GET /rest/v1/codepush_account -> 200`);
    return true;
  }

  const body: string = snippet(response);
  let hint = "";
  if (response.status === 401) {
    hint = "401 = the signature was rejected. Wrong JWT secret, or a token minted for a different project.";
  } else if (/role .* does not exist|42704|set role/i.test(body)) {
    hint =
      "PostgREST could not SET ROLE. 803 does `GRANT codepush_api TO authenticator` inside a DO block\n" +
      "that DOWNGRADES TO A NOTICE when the role name is absent -- so this can be the one statement\n" +
      "in the migration that quietly did nothing.";
  } else if (/permission denied|42501/.test(body)) {
    hint = "The role resolved but its GRANT or its codepush_account_svc_all policy is missing.";
  } else if (response.status === 404 || /PGRST205|PGRST202|does not exist/.test(body)) {
    hint = "803_codepush_core.sql has not been applied to this project.";
  }

  record("2", "PostgREST accepts the JWT and resolves it to a role that can read", "FAIL", `HTTP ${response.status} ${body}${hint ? `\n${hint}` : ""}`);
  return false;
}

// 3. Every table, individually. `limit=0` reads no rows, so this is green on an
// empty project: the question is reachability and permission, not data. One
// request per table rather than one join, because a partially-applied 803 leaves
// SOME tables working, and "which ones" is the whole diagnostic.
async function checkTables(config: Config): Promise<void> {
  const missing: string[] = [];
  const denied: string[] = [];

  for (const table of TABLES) {
    const response: HttpResponse = await httpRequest("GET", `${config.url}/rest/v1/${table}?select=*&limit=0`, authHeaders(config.jwt));
    if (response.status === 200) {
      continue;
    }
    const body: string = snippet(response);
    if (/permission denied|42501/.test(body)) {
      denied.push(`${table} (permission denied)`);
    } else {
      missing.push(`${table} (HTTP ${response.status} ${body})`);
    }
  }

  if (missing.length === 0 && denied.length === 0) {
    record("3", `all ${TABLES.length} codepush_* tables are reachable`, "PASS", "SELECT ... limit 0 on each");
    return;
  }

  record(
    "3",
    `all ${TABLES.length} codepush_* tables are reachable`,
    "FAIL",
    [...missing, ...denied].join("\n") +
      (denied.length ? `\nA 'permission denied' subset means 803's grant loop skipped those tables -- re-run the migration.` : "")
  );
}

// 4. Sequence usage. `codepush_package.id` is GENERATED ALWAYS AS IDENTITY, and
// 803 grants sequence usage in a single statement AFTER the per-table loop. If
// that one line was missed, every read passes and only the first RELEASE fails.
// Probed by reading, not by inserting: an insert here would be a mutation.
async function checkPackageIdentity(config: Config): Promise<void> {
  const response: HttpResponse = await httpRequest("GET", `${config.url}/rest/v1/codepush_package?select=id&limit=1`, authHeaders(config.jwt));
  if (response.status === 200) {
    record("4", "codepush_package is readable (identity column present)", "PASS", "");
    return;
  }
  record("4", "codepush_package is readable (identity column present)", "FAIL", `HTTP ${response.status} ${snippet(response)}`);
}

// 5. codepush_bump_metrics([]) -- a genuine no-op. The function body loops over
// jsonb_array_elements(p_entries); with an empty array the loop never runs, so
// this proves existence + signature + EXECUTE grant and writes nothing.
async function checkBumpMetricsRpc(config: Config): Promise<void> {
  const response: HttpResponse = await httpRequest(
    "POST",
    `${config.url}/rest/v1/rpc/codepush_bump_metrics`,
    authHeaders(config.jwt, { "Content-Type": "application/json" }),
    Buffer.from(JSON.stringify({ p_entries: [] }), "utf8")
  );

  if (response.status >= 200 && response.status < 300) {
    record("5", "RPC codepush_bump_metrics is callable (empty-array no-op)", "PASS", `HTTP ${response.status}`);
    return;
  }

  const body: string = snippet(response);
  const hint: string = /PGRST202|does not exist/.test(body)
    ? "The function is missing -- 803's RPC block did not run."
    : /permission denied|42501/.test(body)
      ? "EXECUTE was not granted to this role -- 803 restates REVOKE/GRANT at the bottom because a DROP resets grants."
      : "";
  record("5", "RPC codepush_bump_metrics is callable (empty-array no-op)", "FAIL", `HTTP ${response.status} ${body}${hint ? `\n${hint}` : ""}`);
}

// 6. codepush_commit_package. There is NO input to this function that both
// succeeds and writes nothing -- committing a package is its entire purpose. So
// the probe uses a deployment id that cannot exist and the EXPECTED result is
// the function's own `no_data_found` RAISE:
//   UPDATE codepush_deployment ... WHERE id = $1 RETURNING label_counter
//   -> matches nothing -> v_seq IS NULL -> RAISE EXCEPTION 'codepush_deployment % not found'
// The RAISE aborts PostgREST's per-request transaction, so even the label_counter
// increment is rolled back. That error is the PASS condition; "function does not
// exist" is the FAIL, and the two are easy to tell apart in the body.
async function checkCommitPackageRpc(config: Config): Promise<void> {
  const impossibleId = `preflight-does-not-exist-${Date.now()}`;
  const response: HttpResponse = await httpRequest(
    "POST",
    `${config.url}/rest/v1/rpc/codepush_commit_package`,
    authHeaders(config.jwt, { "Content-Type": "application/json" }),
    Buffer.from(JSON.stringify({ p_deployment_id: impossibleId, p_package: {} }), "utf8")
  );

  const body: string = snippet(response);

  if (/codepush_deployment .* not found|no_data_found|P0002/.test(body)) {
    record(
      "6",
      "RPC codepush_commit_package exists and is callable (non-mutating probe)",
      "PASS",
      `raised its own 'not found' for a deployment id that cannot exist -- signature and EXECUTE grant confirmed, nothing written`
    );
    return;
  }

  if (response.status >= 200 && response.status < 300) {
    // Unreachable unless someone created a deployment with that literal id, in
    // which case a package WAS committed and a human needs to know immediately.
    record(
      "6",
      "RPC codepush_commit_package exists and is callable (non-mutating probe)",
      "FAIL",
      `the probe SUCCEEDED (HTTP ${response.status}). A deployment with id '${impossibleId}' exists and this call\n` +
        `committed a package into it. Delete that package row before doing anything else.`
    );
    return;
  }

  const hint: string = /PGRST202|does not exist/.test(body)
    ? "The function is missing -- 803's RPC block did not run, or its argument types differ."
    : /permission denied|42501/.test(body)
      ? "EXECUTE was not granted to this role."
      : "";
  record("6", "RPC codepush_commit_package exists and is callable (non-mutating probe)", "FAIL", `HTTP ${response.status} ${body}${hint ? `\n${hint}` : ""}`);
}

// 7. The bucket row itself. `file_size_limit` is per bucket and the container's
// UPLOAD_SIZE_LIMIT_MB is 100, so a lower ceiling turns a legitimate release
// into a 413 halfway through an upload.
async function checkBucket(config: Config): Promise<void> {
  const candidates: Array<{ label: string; key: string }> = [];
  if (config.storageKey) {
    candidates.push({ label: ENV_STORAGE_KEY, key: config.storageKey });
  }
  candidates.push({ label: ENV_JWT, key: config.jwt });
  if (config.serviceRoleKey) {
    // Read-only, and only as a LAST resort: the Storage API's bucket endpoints
    // authorise differently across versions, so a scoped-role 403 here is not
    // proof the bucket is wrong. Naming which credential answered keeps that
    // honest in the report.
    candidates.push({ label: ENV_SERVICE_ROLE_KEY, key: config.serviceRoleKey });
  }

  let last: HttpResponse;
  for (const candidate of candidates) {
    const response: HttpResponse = await httpRequest("GET", `${config.url}/storage/v1/bucket/${config.bucket}`, authHeaders(candidate.key));
    last = response;
    if (response.status !== 200) {
      continue;
    }

    const bucket: { public?: boolean; file_size_limit?: number; allowed_mime_types?: string[] } = JSON.parse(response.body.toString("utf8"));
    const limit: number = Number(bucket.file_size_limit || 0);
    const problems: string[] = [];

    if (limit && limit < REQUIRED_BUCKET_BYTES) {
      problems.push(`file_size_limit is ${limit} bytes, below the required ${REQUIRED_BUCKET_BYTES} (100 MB = UPLOAD_SIZE_LIMIT_MB)`);
    }
    if (!bucket.public) {
      problems.push(
        `public=false. blob_url is PERSISTED FOREVER in codepush_package and copied verbatim by\n` +
          `Promote/Rollback, and the differ re-fetches it weeks later with a bare superagent.get.\n` +
          `A private bucket means signed URLs, and a signed URL expires. See check 8.`
      );
    }
    if (bucket.allowed_mime_types && bucket.allowed_mime_types.length > 0) {
      const required: string[] = ["application/zip", "application/json", "application/octet-stream"];
      const absent: string[] = required.filter((mime: string) => bucket.allowed_mime_types.indexOf(mime) === -1);
      if (absent.length) {
        problems.push(`allowed_mime_types is set and does not include ${absent.join(", ")}`);
      }
    }

    record(
      "7",
      `bucket '${config.bucket}' exists, is public, file_size_limit >= 100 MB`,
      problems.length ? "FAIL" : "PASS",
      problems.length
        ? problems.join("\n")
        : `public=${bucket.public}, file_size_limit=${limit || "unlimited"} (read with ${candidate.label})`
    );
    return;
  }

  record(
    "7",
    `bucket '${config.bucket}' exists, is public, file_size_limit >= 100 MB`,
    "FAIL",
    `could not read the bucket row (last: HTTP ${last ? last.status : 0} ${last ? snippet(last) : ""}).\n` +
      `803 deliberately does NOT create the bucket -- that is a human step. Create it public,\n` +
      `file_size_limit 157286400, allowed_mime_types null. If the bucket does exist, set\n` +
      `${ENV_SERVICE_ROLE_KEY} for this one read: the Storage API's /bucket endpoint authorises\n` +
      `differently from /object and a scoped-role 403 here does not prove the bucket is wrong.`
  );
}

interface BlobProbe {
  id: string;
  sizeBytes: number;
  source: string;
}

// Find something real to download. Prefer the LARGEST blob: a 4 KB probe object
// can pass a check that a 50 MB bundle fails on a proxy body limit or a range
// restriction, and the object the fleet fetches is the big one.
async function discoverBlob(config: Config, flags: Flags): Promise<BlobProbe> {
  if (flags.blobId) {
    return { id: flags.blobId, sizeBytes: 0, source: "--blob" };
  }

  const ledger: HttpResponse = await httpRequest(
    "GET",
    `${config.url}/rest/v1/codepush_blob?select=id,size_bytes&deleted_at=is.null&order=size_bytes.desc&limit=1`,
    authHeaders(config.jwt)
  );
  if (ledger.status === 200) {
    const rows: Array<{ id: string; size_bytes: number }> = JSON.parse(ledger.body.toString("utf8"));
    if (rows.length) {
      return { id: rows[0].id, sizeBytes: Number(rows[0].size_bytes || 0), source: "codepush_blob (largest)" };
    }
  }

  // Before the importer runs, the ledger can be empty while packages already
  // carry URLs (or vice versa). The blobId is the last path segment either way.
  const packages: HttpResponse = await httpRequest(
    "GET",
    `${config.url}/rest/v1/codepush_package?select=blob_url,size_bytes&order=size_bytes.desc&limit=1`,
    authHeaders(config.jwt)
  );
  if (packages.status === 200) {
    const rows: Array<{ blob_url: string; size_bytes: number }> = JSON.parse(packages.body.toString("utf8"));
    if (rows.length && rows[0].blob_url) {
      const id: string = rows[0].blob_url.split("/").pop();
      return { id, sizeBytes: Number(rows[0].size_bytes || 0), source: "codepush_package.blob_url" };
    }
  }

  // "no blob" and "could not ask" are different findings and get different
  // lines: the first is a normal pre-import state, the second means check 8 did
  // not run at all and nobody should read its skip as reassurance.
  if (ledger.status !== 200 || packages.status !== 200) {
    return { id: "", sizeBytes: 0, source: `unreadable: codepush_blob -> ${ledger.status}, codepush_package -> ${packages.status} ${snippet(packages)}` };
  }

  return null;
}

// 8. THE CHECK THAT MATTERS MOST. No auth header of any kind -- not `apikey`,
// not `Authorization` -- because a till in a shop sends neither. HEAD first so a
// 50 MB object costs nothing; a ranged GET as the fallback for a deployment
// where HEAD is not routed.
async function checkAnonymousBlobRead(config: Config, flags: Flags): Promise<void> {
  const title = "an object under blobs/ is readable ANONYMOUSLY (a 403 here bricks tills)";
  const probe: BlobProbe = await discoverBlob(config, flags);

  if (probe && !probe.id) {
    record("8", title, "SKIP", `could not look for a blob to test -- ${probe.source}`);
    return;
  }

  if (!probe) {
    record(
      "8",
      title,
      "SKIP",
      `no blob to test: codepush_blob and codepush_package are both empty. That is expected BEFORE\n` +
        `the importer runs, and unacceptable after it. Re-run with --blob <id>, and re-run this whole\n` +
        `script with --strict once the import is done -- this line must be green before either flip.`
    );
    return;
  }

  const objectUrl = `${config.publicUrl}/storage/v1/object/public/${config.bucket}/${BLOB_PREFIX}/${probe.id}`;

  let response: HttpResponse = await httpRequest("HEAD", objectUrl, {});
  if (response.status === 405 || response.status === 404) {
    // 404 on HEAD but 206 on a ranged GET happens on some storage-api versions;
    // one byte is enough to prove the object is served anonymously.
    const ranged: HttpResponse = await httpRequest("GET", objectUrl, { Range: "bytes=0-0" });
    if (ranged.status === 200 || ranged.status === 206) {
      response = ranged;
    }
  }

  const served: boolean = response.status === 200 || response.status === 206;
  const contentLength: string = String(response.headers["content-length"] || "");
  const sizeNote: string =
    probe.sizeBytes && probe.sizeBytes < PREFERRED_BLOB_BYTES
      ? `\nNOTE: the object tested is ${probe.sizeBytes} bytes, under the 50 MB the runbook asks for.\n` +
        `A small object can pass where a real bundle trips a proxy body limit. Before FLIP B, repeat\n` +
        `this against a real bundle, from OFF-NETWORK (a phone on cellular, not this laptop).`
      : "";

  if (served) {
    record("8", title, "PASS", `HTTP ${response.status} for ${probe.source} '${probe.id}' (content-length ${contentLength || "n/a"})${sizeNote}`);
    return;
  }

  record(
    "8",
    title,
    "FAIL",
    `HTTP ${response.status} on ${objectUrl}\n` +
      `THIS IS THE STATE THAT BRICKS TILLS. A mandatory release with an unreadable bundle leaves\n` +
      `CodePushBlocker owning the screen with Retry as the only button, and there is no OTA path to\n` +
      `the fix. Do not flip anything until this is a 200. Usual cause: the bucket is not public, or a\n` +
      `RESTRICTIVE storage.objects policy was written FOR ALL (which also covers SELECT) instead of\n` +
      `per-command INSERT/UPDATE/DELETE -- 803 is deliberately per-command for exactly this reason.`
  );
}

// 9. The negative. A tenant JWT must NOT be able to write into this bucket: a
// bundle URL is persisted forever and cached by every till's SDK, so a writable
// bucket is arbitrary code execution on the whole POS fleet from an ordinary
// employee account. Migration 024 grants exactly that shape of blanket
// authenticated INSERT/UPDATE/DELETE on LazyWaitStorage, which is why CodePush
// got its own bucket.
//
// The probe writes under `preflight/`, never `blobs/`: if the setup IS wrong,
// the object that lands cannot shadow a bundle anything downloads.
async function checkTenantCannotWrite(config: Config, flags: Flags): Promise<void> {
  const title = "a tenant/anon JWT CANNOT write to the bucket (expect 403)";

  if (flags.skipAnonWrite) {
    record("9", title, "SKIP", "--skip-anon-write");
    return;
  }
  if (!flags.anonKey) {
    record(
      "9",
      title,
      "SKIP",
      `no anon credential. Set ${ENV_ANON_KEY} or pass --anon-key. A tenant-equivalent probe token\n` +
        `can also be minted: node bin/script/scripts/mint-codepush-jwt.js --role authenticated --expires 1h`
    );
    return;
  }

  const objectPath = `preflight/anon-write-probe-${Date.now()}.txt`;
  const objectUrl = `${config.url}/storage/v1/object/${config.bucket}/${objectPath}`;
  const response: HttpResponse = await httpRequest(
    "POST",
    objectUrl,
    authHeaders(flags.anonKey, { "Content-Type": "text/plain", "x-upsert": "false" }),
    Buffer.from("codepush preflight probe -- this object should never have been created", "utf8")
  );

  if (response.status === 403 || response.status === 401 || /row-level security|Unauthorized|new row violates/i.test(snippet(response))) {
    record("9", title, "PASS", `HTTP ${response.status} -- the write was refused`);
    return;
  }

  if (response.status >= 200 && response.status < 300) {
    // The probe succeeded, which is the finding. Clean up immediately and, if
    // cleanup fails, hand the operator the exact path rather than a shrug.
    const cleanup: HttpResponse = await httpRequest("DELETE", objectUrl, authHeaders(flags.anonKey));
    const cleaned: boolean = cleanup.status >= 200 && cleanup.status < 300;
    record(
      "9",
      title,
      "FAIL",
      `an ordinary tenant credential WROTE to '${config.bucket}' (HTTP ${response.status}).\n` +
        `A bundle URL is persisted forever and cached by every till's SDK, so a writable bundle bucket\n` +
        `is arbitrary code execution on the whole POS fleet from a cashier's account.\n` +
        (cleaned
          ? `The probe object was deleted again.`
          : `THE PROBE OBJECT COULD NOT BE DELETED (HTTP ${cleanup.status}). Remove it by hand: ${config.bucket}/${objectPath}`) +
        `\nCheck for a permissive, bucket-agnostic storage.objects policy added after 803.`
    );
    return;
  }

  record("9", title, "WARN", `HTTP ${response.status} ${snippet(response)} -- neither a clear refusal nor a write; look at it by hand`);
}

// 10. The same credential against the tables. A readable codepush_access_key
// hands out the sha256 token hashes that gate every management route, so this is
// the table whose exposure would be worst; 803 REVOKEs anon/authenticated and
// adds a deny-all policy, and this asserts both actually landed.
async function checkTenantCannotReadTables(config: Config, flags: Flags): Promise<void> {
  const title = "a tenant/anon JWT CANNOT read codepush_access_key";

  if (!flags.anonKey) {
    record("10", title, "SKIP", `no anon credential (see check 9)`);
    return;
  }

  const response: HttpResponse = await httpRequest("GET", `${config.url}/rest/v1/codepush_access_key?select=name_hash&limit=1`, authHeaders(flags.anonKey));
  const body: string = snippet(response);

  if (response.status === 401 || response.status === 403 || /permission denied|42501/.test(body)) {
    record("10", title, "PASS", `HTTP ${response.status} -- denied`);
    return;
  }

  if (response.status === 200) {
    const rows: unknown[] = JSON.parse(response.body.toString("utf8"));
    if (Array.isArray(rows) && rows.length === 0) {
      // RLS denying every row reads as an empty 200 through PostgREST. That is
      // the deny-all policy working -- but only while the table is empty is it
      // indistinguishable from an empty table, so say which one this is.
      record("10", title, "PASS", `HTTP 200 with zero rows -- the deny-all policy is filtering (or the table is empty)`);
      return;
    }
    record("10", title, "FAIL", `HTTP 200 returned ${(rows as unknown[]).length} row(s). Those are the token hashes gating every management route.`);
    return;
  }

  record("10", title, "WARN", `HTTP ${response.status} ${body}`);
}

// ── conformance chaining ─────────────────────────────────────────────────────

// The "single command" half of this file. The harness's Supabase leg is gated on
// TEST_SUPABASE_STORAGE, and setting an env var for one command is not portable
// between bash and PowerShell -- so it is set here, in-process, for the child.
// Chaining it AFTER the preflight is not cosmetic: the harness writes real rows,
// and a harness failure against a project whose bucket does not exist wastes an
// afternoon looking at adapter code.
function runConformance(config: Config): number {
  const prodUrl: string = (process.env[ENV_PROD_URL] || "").replace(/\/+$/, "");
  if (prodUrl && prodUrl === config.url) {
    say("");
    say(
      `[${TOOL}] REFUSING --conformance: ${ENV_URL} equals ${ENV_PROD_URL}.\n` +
        `        The harness WRITES: one account, two apps, two deployments, ~8 packages. It removes the\n` +
        `        apps again, but Storage has no account-delete verb, so a run always leaves a row behind.\n` +
        `        Point it at the dev project.`
    );
    return 1;
  }

  if (!prodUrl) {
    // The refusal above can only fire when it knows what prod IS. Say so rather
    // than let an unset variable read as "checked, and this is not prod" -- the
    // guard is the only thing standing between `--conformance` and a write into
    // the live project, and an inert guard that looks armed is worse than none.
    say("");
    say(
      `[${TOOL}] NOTE: ${ENV_PROD_URL} is not set, so the "is this production?" guard could not run.\n` +
        `        The harness is about to WRITE to ${config.url}. Confirm that is the DEV project before\n` +
        `        letting it continue, and set ${ENV_PROD_URL} on this machine so the guard works next time.`
    );
  }

  const harness: string = path.resolve(__dirname, "../../test/storage-conformance.js");
  if (!fs.existsSync(harness)) {
    say(`[${TOOL}] --conformance: ${harness} not found. Run 'yarn build' first.`);
    return 1;
  }

  say("");
  say(`[${TOOL}] preflight green -- running the storage conformance harness against ${config.url}`);
  say(`[${TOOL}] (this WRITES to the project: one account, two apps, two deployments, ~8 packages)`);
  say("");

  const child = childProcess.spawnSync(process.execPath, [harness], {
    stdio: "inherit",
    env: { ...process.env, TEST_SUPABASE_STORAGE: "1" },
  });

  return child.status === 0 ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const flags: Flags = parseFlags(process.argv.slice(2));
  const config: Config = resolveConfig();

  say("");
  say(`${TOOL} -- READ-ONLY preflight`);
  say(`  project ${config.url}`);
  say(`  bucket  ${config.bucket}`);
  say(`  public  ${config.publicUrl}`);
  say("");

  checkTokenClaims(config);

  // Checks 3-8 all assume the credential works at all. When check 2 fails they
  // would each fail identically and bury the one line that matters, so stop.
  const reachable: boolean = await checkPostgrestAcceptsToken(config);
  if (reachable) {
    await checkTables(config);
    await checkPackageIdentity(config);
    await checkBumpMetricsRpc(config);
    await checkCommitPackageRpc(config);
  } else {
    ["3", "4", "5", "6"].forEach((id: string) => record(id, "(schema checks)", "SKIP", "skipped: the credential could not read the project"));
  }

  await checkBucket(config);
  await checkAnonymousBlobRead(config, flags);
  await checkTenantCannotWrite(config, flags);
  await checkTenantCannotReadTables(config, flags);

  const failed: CheckResult[] = results.filter((result: CheckResult) => result.status === "FAIL");
  const skipped: CheckResult[] = results.filter((result: CheckResult) => result.status === "SKIP");
  const warned: CheckResult[] = results.filter((result: CheckResult) => result.status === "WARN");

  say("");
  say(
    `${failed.length === 0 && (!flags.strict || skipped.length === 0) ? "PASS" : "FAIL"} -- ` +
      `${results.length - failed.length - skipped.length - warned.length} passed, ${failed.length} failed, ` +
      `${warned.length} warned, ${skipped.length} skipped${flags.strict ? " (--strict: a skip is a failure)" : ""}`
  );

  if (flags.json) {
    console.log(JSON.stringify({ url: config.url, bucket: config.bucket, results }, null, 2));
  }

  if (failed.length > 0 || (flags.strict && skipped.length > 0)) {
    return 1;
  }

  if (flags.conformance) {
    return runConformance(config);
  }

  return 0;
}

main().then(
  (code: number) => process.exit(code),
  (reason: unknown) => {
    // Message only, never the object: a rejected request carries its own options,
    // and those options carry the Authorization header.
    say(`[${TOOL}] ERROR ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(2);
  }
);
