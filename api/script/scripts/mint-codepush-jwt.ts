// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// =============================================================================
// mint-codepush-jwt.ts  --  mint the PostgREST JWT the CodePush container runs on
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Migration 803_codepush_core.sql creates a NOLOGIN role `codepush_api` and
// grants it exactly the nine `codepush_*` tables, the two RPCs, and write access
// to the `LazyWaitCodePush` bucket -- and nothing else. The container reaches
// PostgREST and the Storage API as that role by presenting a JWT whose `role`
// claim is `codepush_api`, signed with the project's JWT secret. This script is
// the only supported way to produce that token.
//
// It exists as a script, rather than a wiki paragraph, because the alternative
// people reach for is the service-role key. That key is scoped to NOTHING: it
// bypasses RLS on every table in the project, so handing it to a 12-year-old
// fork that buffers 100 MB uploads in memory would give that fork `pos_orders`,
// `hrms_employees` and `platform_support_access_log`. The Azure storage-account
// key this migration replaces had a strictly SMALLER blast radius than that.
//
// WHY IT VERIFIES WHAT IT JUST MINTED
// -----------------------------------
// A JWT signed with the wrong secret is indistinguishable from a correct one by
// eye: same three dot-separated segments, same decodable payload, same role
// claim. It fails only at request time, and it fails as `401 {"message":"JWSError
// JWSInvalidSignature"}` surfaced through `@supabase/supabase-js` -> `toStorageError`
// -> `ErrorCode.ConnectionFailed` -> an opaque 500 from a route that has nothing
// to do with authentication. Every minute spent on that is a minute spent
// looking at the wrong file.
//
// So the default path here is: mint, then PROVE the token by using it. Two
// checks, in this order:
//
//   1. LOCAL  -- recompute the signature over the encoded header+payload and
//      byte-compare. This catches a mangled secret (a trailing newline from a
//      `cat`, a shell that ate a `$`, base64 pasted where raw was wanted) and it
//      costs no network. It CANNOT catch a well-formed but WRONG secret -- the
//      signature is self-consistent by construction. That is what check 2 is for
//      and why check 2 is not optional by default.
//
//   2. LIVE   -- one read against `codepush_account` through PostgREST. A 200
//      proves four separate things at once: the signature is accepted by the
//      project (the secret is RIGHT, not merely well-formed), `authenticator` is
//      a member of `codepush_api` so the per-request `SET ROLE` succeeded, the
//      GRANT exists, and 803's `*_svc_all` policy lets the role past its own
//      deny-all. Any of those missing is a different HTTP status with a
//      different body, and this script prints which.
//
// `--no-verify` exists for minting a token for a project you cannot reach from
// where you are standing (an air-gapped hand-off). Use it and you own the
// consequence.
//
// THE SECRET IS NEVER PRINTED, NEVER LOGGED, NEVER ECHOED IN AN ERROR
// -------------------------------------------------------------------
// Not on success, not in a stack trace, not in the "here is what I read"
// diagnostic. Prefer `SUPABASE_JWT_SECRET` in the environment or `--secret-file`
// over `--secret`: an argv value is visible in shell history and to every other
// process on the box via the process table.
//
// USAGE
// -----
//   cd api
//   yarn build                                  # compiles script/ -> bin/script/
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_JWT_SECRET=<project jwt secret> \
//     node bin/script/scripts/mint-codepush-jwt.js
//
//   node bin/script/scripts/mint-codepush-jwt.js --expires 10y
//   node bin/script/scripts/mint-codepush-jwt.js --secret-file ./jwt.secret
//   node bin/script/scripts/mint-codepush-jwt.js --role authenticated --expires 1h
//         ^ a TENANT-EQUIVALENT probe token for verify-supabase-setup.ts's
//           "an ordinary tenant JWT cannot write to the bucket" check. It is not
//           a credential for anything; mint it short-lived and throw it away.
//
// | flag | effect |
// |---|---|
// | `--expires <10y\|365d\|24h\|3600s>` | token lifetime, default 10y |
// | `--role <name>` | `role` claim, default `codepush_api` |
// | `--url <https://ref.supabase.co>` | project URL; defaults to `SUPABASE_URL` |
// | `--secret <value>` | the JWT secret (LAST resort -- see above) |
// | `--secret-file <path>` | read the secret from a file, trailing newline trimmed |
// | `--no-verify` | skip the LIVE check (the local one always runs) |
// | `--quiet` | print ONLY the token on stdout, nothing else |
//
// `--quiet` is the one that makes this composable:
//   SUPABASE_CODEPUSH_JWT=$(node bin/script/scripts/mint-codepush-jwt.js --quiet)
// Everything else this script writes goes to stderr precisely so that redirect
// stays clean.
//
// EXIT CODES: 0 minted and verified; 1 anything else. There is no "minted but
// probably fine" exit -- that state is the whole problem this file solves.
// =============================================================================

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";

const TOOL = "mint-codepush-jwt";

// The role 803 creates. Anything else is a probe token, and the script says so.
const DEFAULT_ROLE = "codepush_api";

// Ten years. This is a machine credential baked into a container's environment
// on a box nobody logs into weekly; a one-year expiry means an outage on a date
// nobody has in a calendar, and the failure mode is the whole OTA channel going
// dark rather than anything graceful. Rotation is a deliberate act (mint a new
// one, restart the container), not a timer.
const DEFAULT_EXPIRES = "10y";

// The table the live check reads. `codepush_account` is the same table
// SupabaseStorage.checkHealth() probes, so a green mint and a green /health mean
// the same thing about the credential.
const VERIFY_TABLE = "codepush_account";

const ENV_SECRET = "SUPABASE_JWT_SECRET";
const ENV_URL = "SUPABASE_URL";

const USAGE = [
  `usage: node bin/script/scripts/mint-codepush-jwt.js [flags]`,
  ``,
  `  --expires <10y|365d|24h|3600s>  token lifetime (default ${DEFAULT_EXPIRES})`,
  `  --role <name>                   role claim (default ${DEFAULT_ROLE})`,
  `  --url <https://ref.supabase.co> project URL (default $${ENV_URL})`,
  `  --secret <value>                JWT secret -- LAST resort, argv is visible`,
  `  --secret-file <path>            read the JWT secret from a file`,
  `  --no-verify                     skip the live project check`,
  `  --quiet                         print only the token on stdout`,
  ``,
  `  The secret is read from $${ENV_SECRET} when no flag supplies it, and is never printed.`,
].join("\n");

interface Flags {
  expires: string;
  role: string;
  url: string;
  secret: string;
  secretSource: string;
  verify: boolean;
  quiet: boolean;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// Everything diagnostic goes to stderr so `--quiet` leaves stdout holding
// exactly one line: the token.
function log(message: string): void {
  console.error(`[${TOOL}] ${message}`);
}

function die(message: string): never {
  console.error(`[${TOOL}] ERROR ${message}`);
  process.exit(1);
}

// ── argv ─────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    expires: DEFAULT_EXPIRES,
    role: DEFAULT_ROLE,
    url: process.env[ENV_URL] || "",
    secret: "",
    secretSource: "",
    verify: true,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg: string = argv[i];
    switch (arg) {
      case "--expires":
        flags.expires = argv[++i];
        break;
      case "--role":
        flags.role = argv[++i];
        break;
      case "--url":
        flags.url = argv[++i];
        break;
      case "--secret":
        // Accepted, discouraged in the header, and NOT echoed back anywhere.
        flags.secret = argv[++i];
        flags.secretSource = "--secret (argv -- visible in shell history and the process table)";
        break;
      case "--secret-file":
        {
          const file: string = argv[++i];
          if (!fs.existsSync(file)) {
            die(`--secret-file '${file}' does not exist`);
          }
          flags.secret = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
          flags.secretSource = `--secret-file ${file}`;
        }
        break;
      case "--no-verify":
        flags.verify = false;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      case "--help":
      case "-h":
        console.error(USAGE);
        process.exit(0);
        break;
      default:
        die(`Unknown flag '${arg}'. See the header of this file for usage.`);
    }
  }

  if (!flags.secret) {
    const fromEnv: string = process.env[ENV_SECRET] || "";
    if (fromEnv) {
      flags.secret = fromEnv;
      flags.secretSource = `${ENV_SECRET} (environment)`;
    }
  }

  if (!flags.secret) {
    die(
      `No JWT secret. Set ${ENV_SECRET}, or pass --secret-file <path>.\n` +
        `        Supabase dashboard -> Project Settings -> API -> JWT Settings -> JWT Secret.\n` +
        `        It is NOT the anon key and NOT the service-role key -- those are themselves\n` +
        `        JWTs signed WITH this secret.`
    );
  }

  if (!flags.role) {
    die("--role cannot be empty");
  }

  return flags;
}

// `10y` / `365d` / `24h` / `3600s` / a bare number of seconds.
function parseDurationSeconds(spec: string): number {
  const match: RegExpMatchArray = /^(\d+)([smhdy]?)$/.exec(spec || "");
  if (!match) {
    die(`--expires '${spec}' is not a duration. Use 10y, 365d, 24h, 3600s or a plain number of seconds.`);
  }
  const value: number = parseInt(match[1], 10);
  const unit: string = match[2] || "s";
  const multiplier: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    // 365 days, not 365.25. An OTA credential's expiry does not need to track
    // the tropical year; it needs to be a number two people can agree on.
    y: 31536000,
  };
  const seconds: number = value * multiplier[unit];
  if (seconds <= 0) {
    die(`--expires '${spec}' resolves to ${seconds}s`);
  }
  return seconds;
}

// ── JWT ──────────────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString("base64url") : Buffer.from(input, "utf8").toString("base64url");
}

// The project ref is the first label of `<ref>.supabase.co`. Supabase's own
// tokens carry it as `ref`, and including it means a token minted for the dev
// project is visibly not a prod token when someone decodes it on a bad day. It
// is NOT load-bearing: PostgREST reads `role` and `exp` and nothing else here.
function projectRefFromUrl(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const host: string = new URL(url).hostname;
    const first: string = host.split(".")[0];
    return /^[a-z0-9]{16,32}$/.test(first) ? first : "";
  } catch (reason) {
    return "";
  }
}

interface MintedToken {
  token: string;
  issuedAt: number;
  expiresAt: number;
  payload: Record<string, string | number>;
}

function mint(secret: string, role: string, lifetimeSeconds: number, url: string): MintedToken {
  const issuedAt: number = Math.floor(Date.now() / 1000);
  const expiresAt: number = issuedAt + lifetimeSeconds;

  // HS256 is not a choice: it is what Supabase's gateway and PostgREST validate
  // a project JWT with. `typ: JWT` is there because some proxies look for it.
  const header: Record<string, string> = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, string | number> = {
    role,
    iss: "supabase",
    iat: issuedAt,
    exp: expiresAt,
  };
  const ref: string = projectRefFromUrl(url);
  if (ref) {
    payload.ref = ref;
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature: string = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(signingInput).digest("base64url");

  return { token: `${signingInput}.${signature}`, issuedAt, expiresAt, payload };
}

// Check 1 (LOCAL). Re-derives the signature from the token's own first two
// segments and compares in constant time. This is not theatre: it is the check
// that catches a secret carrying a trailing newline or a shell-expanded `$`,
// both of which produce a token that looks perfect and is rejected by the
// project. It cannot detect a well-formed WRONG secret -- only the live check
// can, which is why the live check is on by default.
function verifyLocally(token: string, secret: string): void {
  const segments: string[] = token.split(".");
  if (segments.length !== 3) {
    die(`the minted token has ${segments.length} segments, not 3 -- refusing to hand that out`);
  }

  const expected: Buffer = crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${segments[0]}.${segments[1]}`)
    .digest();
  const actual: Buffer = Buffer.from(segments[2], "base64url");

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    die("the minted token does not verify against the secret it was signed with (this should be impossible -- do not use it)");
  }

  const decoded: Record<string, string | number> = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  if (!decoded.role) {
    die("the minted token carries no `role` claim -- PostgREST would run it as the anonymous role");
  }
}

// ── http ─────────────────────────────────────────────────────────────────────

function httpRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<HttpResponse> {
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

// Check 2 (LIVE). One read, no writes, safe against production.
async function verifyAgainstProject(token: string, url: string, role: string, apiKey: string): Promise<void> {
  const base: string = url.replace(/\/+$/, "");
  // `limit=0` reads no rows, so this is green on an empty project too -- the
  // question is "is this credential accepted and authorised", not "is there
  // data".
  //
  // TWO HEADERS, TWO DIFFERENT CREDENTIALS. An earlier revision sent the minted
  // token as `apikey` too, on the assumption that "for a self-signed project JWT
  // it takes the same value as the bearer". That is WRONG on Supabase Cloud: the
  // gateway authenticates `apikey` against the project's OWN issued keys, so a
  // self-signed codepush_api JWT is rejected there -- before PostgREST, before
  // any role or policy is consulted -- as
  //   {"message":"Invalid API key","hint":"Double check your Supabase `anon` or
  //    `service_role` API key."}
  // which reads exactly like a wrong JWT secret and is not. Verifying a correct
  // token failed with a message accusing the secret.
  //
  // `apikey` = the anon key: identifies the PROJECT. It authorises nothing here;
  // 803 REVOKEs anon from every codepush_* table.
  // `Authorization` = the minted token: identifies the ROLE.
  const response: HttpResponse = await httpRequest("GET", `${base}/rest/v1/${VERIFY_TABLE}?select=*&limit=0`, {
    apikey: apiKey,
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });

  if (response.status === 200) {
    log(`verified LIVE: ${base} accepted the token and ${role} can read ${VERIFY_TABLE}`);
    return;
  }

  const body: string = response.body.toString("utf8").slice(0, 400);

  // Each of these is a different file to open, so name them apart rather than
  // printing one "verification failed".
  if (response.status === 401) {
    die(
      `${base} REJECTED the token (401). The secret is wrong or belongs to a different project.\n` +
        `        ${body}\n` +
        `        Supabase dashboard -> Project Settings -> API -> JWT Settings -> JWT Secret,\n` +
        `        for the project ${base} points at.`
    );
  }
  if (response.status === 404 || /does not exist|PGRST205|PGRST202/.test(body)) {
    die(
      `the token was accepted but ${VERIFY_TABLE} is not there (${response.status}).\n` +
        `        ${body}\n` +
        `        Migration 803_codepush_core.sql has not been applied to this project.`
    );
  }
  if (/role .* does not exist|unrecognized configuration|42704|set role/i.test(body)) {
    die(
      `the token was accepted but PostgREST could not SET ROLE ${role} (${response.status}).\n` +
        `        ${body}\n` +
        `        803 grants codepush_api TO authenticator; if that GRANT was skipped (the\n` +
        `        migration downgrades it to a NOTICE when the role is absent), every request\n` +
        `        from the container fails here, before any policy or grant is consulted.`
    );
  }
  die(
    `verification against ${base} failed: HTTP ${response.status}\n` +
      `        ${body}\n` +
      `        42501 / "permission denied" means the role resolved but 803's GRANT or its\n` +
      `        ${role}_svc_all policy is missing on ${VERIFY_TABLE}.`
  );
}

// ── output ───────────────────────────────────────────────────────────────────

function printExportBlock(flags: Flags, minted: MintedToken): void {
  const url: string = flags.url || `https://<ref>.supabase.co`;
  const expiry: string = new Date(minted.expiresAt * 1000).toISOString();

  console.error("");
  console.error(`  role     ${flags.role}`);
  console.error(`  project  ${flags.url || "(not given -- pass --url or set SUPABASE_URL)"}`);
  console.error(`  issued   ${new Date(minted.issuedAt * 1000).toISOString()}`);
  console.error(`  expires  ${expiry}`);
  console.error("");
  console.error("  # bash / the container env file");
  console.error(`  export SUPABASE_URL=${url}`);
  console.error(`  export SUPABASE_CODEPUSH_JWT=${minted.token}`);
  console.error(`  export SUPABASE_CODEPUSH_BUCKET=LazyWaitCodePush`);
  console.error("");
  console.error("  # PowerShell");
  console.error(`  $env:SUPABASE_URL="${url}"`);
  console.error(`  $env:SUPABASE_CODEPUSH_JWT="${minted.token}"`);
  console.error(`  $env:SUPABASE_CODEPUSH_BUCKET="LazyWaitCodePush"`);
  console.error("");

  if (flags.role === DEFAULT_ROLE) {
    console.error(`  This ONE credential covers both PostgREST and the Storage API -- verified`);
    console.error(`  against a hosted project: a bucket write with this token returns 200 while`);
    console.error(`  the anon key is refused. That holds even though 803's storage-schema GRANTs`);
    console.error(`  raise 42501 on Supabase Cloud, so do NOT read those NOTICEs as "I need a`);
    console.error(`  stronger key". Leave SUPABASE_CODEPUSH_STORAGE_KEY unset; set it only to put`);
    console.error(`  bucket writes on a separately-rotated credential.`);
    console.error(`  The service-role key NEVER belongs in this container's environment.`);
  } else {
    console.error(`  NOTE: role='${flags.role}', not '${DEFAULT_ROLE}'. This is a PROBE token, not the`);
    console.error(`  container credential. Do not put it in a compose file.`);
  }
  console.error("");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags: Flags = parseFlags(process.argv.slice(2));
  const lifetime: number = parseDurationSeconds(flags.expires);

  if (!flags.quiet) {
    log(`secret read from ${flags.secretSource}`);
  }

  const minted: MintedToken = mint(flags.secret, flags.role, lifetime, flags.url);
  verifyLocally(minted.token, flags.secret);

  if (flags.verify) {
    if (!flags.url) {
      die(
        `cannot verify the minted token: no project URL. Set ${ENV_URL}, pass --url, or pass\n` +
          `        --no-verify and accept that a wrong secret will surface later as an opaque 500.`
      );
    }
    // The gateway's `apikey` header must be one of the project's OWN keys -- see
    // verifyAgainstProject. Without it the live check cannot run at all, and
    // failing here is far better than sending the minted token as `apikey` and
    // reporting a correct secret as wrong.
    const apiKey: string = process.env.SUPABASE_CODEPUSH_APIKEY || process.env.SUPABASE_ANON_KEY || "";
    if (!apiKey) {
      die(
        `cannot verify the minted token: no project apikey. Set SUPABASE_ANON_KEY (or\n` +
          `        SUPABASE_CODEPUSH_APIKEY) to the project's ANON key, or pass --no-verify.\n` +
          `        This is the gateway's project-routing header and is NOT the JWT secret:\n` +
          `        it authorises nothing, because 803 revokes anon from every codepush_* table.`
      );
    }
    await verifyAgainstProject(minted.token, flags.url, flags.role, apiKey);
  } else {
    log("WARNING --no-verify: the signature is self-consistent but NOTHING proves the secret is the project's.");
  }

  // The token, alone, on stdout. `--quiet` composes; the block is a convenience.
  console.log(minted.token);
  if (!flags.quiet) {
    printExportBlock(flags, minted);
  }
}

main().then(
  () => process.exit(0),
  (reason: unknown) => {
    // Deliberately narrow: print the message, never the object graph. A thrown
    // error from `httpRequest` can carry the request options, and the request
    // options carry the Authorization header.
    console.error(`[${TOOL}] ERROR ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(1);
  }
);
