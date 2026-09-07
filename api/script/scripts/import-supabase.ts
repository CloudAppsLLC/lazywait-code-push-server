// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// import-supabase.ts -- loads an export-azure.ts dump into migration 803's schema.
//
// WHY THIS EXISTS, AND WHAT IT MUST NOT GET WRONG
// ----------------------------------------------
// Everything this script writes is either irreplaceable or load-bearing on
// devices already in the field. Four invariants, each of which has a concrete
// failure mode if broken:
//
//   1. DEPLOYMENT KEYS MIGRATE VERBATIM. A key is compiled into the native
//      binary (strings.xml, Info.plist, lazywaitone.cpp) and JS can override it
//      only per-call. A regenerated key strands every fielded till on that
//      channel FOREVER -- there is no OTA path to fix an OTA channel. This
//      script therefore ASSERTS the key it wrote equals the key it read, per
//      deployment, rather than trusting that it did.
//   2. access_key.name_hash MIGRATES VERBATIM. Tokens are stored as
//      sha256(name) (azure-storage.ts:1236-1239) and the bearer strategy looks
//      them up by that hash. Copy it byte for byte and every CLI token, every
//      developer's .code-push.config and the dashboard proxy's
//      CODEPUSH_AUTH_TOKEN keep working across the cutover. Regenerate it and
//      every one of them is revoked at once.
//   3. TIMESTAMPS COME FROM THE SOURCE, NEVER FROM DEFAULT now(). Every
//      created_at / uploaded_at column in 803 has a DEFAULT, and taking it
//      stamps all 50 releases of every deployment with the cutover date --
//      which IS losing the release history, in the only form anyone ever reads
//      it (`code-push deployment history`).
//   4. label_counter IS THE HIGHEST LABEL, NOT THE ROW COUNT. Azure's history
//      blob is a rolling window of the last 50 entries trimmed from the FRONT
//      (azure-storage.ts:739-740) while getNextLabel counts off the LAST label
//      (:1402-1410). A deployment with 86 releases holds labels v37..v86 in 50
//      slots. Setting label_counter to 50 makes the next release "v51" -- a
//      label already installed on tills, which either 23505s the release
//      pipeline dead mid-cutover or ships a duplicate label that makes
//      `rollback -t v51` ambiguous.
//
// IDEMPOTENT BY CONSTRUCTION. Every row is addressed by its natural key (the
// Azure shortid, or (deployment_id,label) for packages, or the blobId for a
// storage object) and upserted. Blob bytes are skipped when both the ledger row
// and the object already exist. Re-running after an interruption is the
// intended recovery path -- see the "Import" section of README.md.
//
// SAFETY
//   * Refuses to do anything without --confirm.
//   * Refuses to touch a project whose codepush_* tables already hold rows
//     unless --merge is also given.
//   * --dry-run performs every read and every check and writes nothing.
//   * Metrics are written ABSOLUTELY (a snapshot, not a delta) and therefore
//     must not be re-run once the new server is live and the fleet is
//     reporting -- doing so would clobber live counters with the frozen Azure
//     numbers. Use --skip-metrics on any post-cutover re-run.
//
// CREDENTIALS. This needs the SERVICE-ROLE key, not the codepush_api JWT the
// container runs with: it writes objects into the LazyWaitCodePush bucket,
// which is service-role-write-only by design. That is correct for a one-shot
// operator tool run from a laptop and wrong for anything shipped -- the key
// never belongs in the container's environment.
//
// USAGE
//   node bin/script/scripts/import-supabase.js <export-dir> --confirm [flags]
//
//   <export-dir>      an export-* run directory, or the parent directory of one
//                     (the newest complete run named by latest.json is used)
//   --confirm         required; without it nothing is written
//   --merge           allow writing into codepush_* tables that already hold rows
//   --dry-run         read and validate everything, write nothing
//   --skip-blobs      do not copy blob bytes (rows still reference blobs/{id})
//   --skip-metrics    do not import Redis metrics
//   --allow-missing-blobs
//                     downgrade a blob that is gone from Azure from an error to
//                     a warning (it is still an error for a deployment's CURRENT
//                     package -- that one is being served right now)
//   --allow-missing-timestamps
//                     downgrade a row with no createdTime/uploadTime from an
//                     error to a warning (it will take DEFAULT now(); see #3)
//   --concurrency <n> parallel blob copies, default 4

import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

const BUCKET = "LazyWaitCodePush";
const BLOB_PREFIX = "blobs/";
const DEFAULT_CONCURRENCY = 4;

// Every table 803 creates, in FK order. Used by the pre-flight emptiness check.
const CODEPUSH_TABLES: string[] = [
  "codepush_account",
  "codepush_app",
  "codepush_app_collaborator",
  "codepush_deployment",
  "codepush_blob",
  "codepush_package",
  "codepush_package_diff_blob",
  "codepush_access_key",
  "codepush_deployment_metric",
];

// ── shapes read out of the export ────────────────────────────────────────────

interface RawEntity {
  partitionKey: string;
  rowKey: string;
  [property: string]: unknown;
}

interface ClassifiedEntity {
  kind: string;
  accountId?: string;
  appId?: string;
  deploymentId?: string;
  accessKeyId?: string;
  accessKeyNameHash?: string;
  deploymentKey?: string;
  email?: string;
  entity: RawEntity;
}

interface EntityFile {
  kind: string;
  count: number;
  items: ClassifiedEntity[];
}

interface HistoryFile {
  deployment_id: string;
  blob_missing: boolean;
  count: number;
  packages: SourcePackage[];
}

interface BlobInventoryFile {
  container: string;
  count: number;
  items: { name: string; size: number; content_type: string }[];
}

interface RedisMetricsFile {
  hashes: Record<string, Record<string, number>>;
}

interface SourceBlobInfo {
  size: number;
  url: string;
}

interface SourcePackage {
  appVersion: string;
  blobUrl: string;
  description?: string;
  diffPackageMap?: Record<string, SourceBlobInfo>;
  isDisabled?: boolean;
  isMandatory?: boolean;
  label?: string;
  manifestBlobUrl?: string;
  originalDeployment?: string;
  originalLabel?: string;
  packageHash: string;
  releasedBy?: string;
  releaseMethod?: string;
  rollout?: number;
  size: number;
  uploadTime?: number | string;
}

interface SourceCollaborator {
  accountId?: string;
  permission: string;
}

// ── shapes written to Postgres ───────────────────────────────────────────────

interface PackageRow {
  deployment_id: string;
  label: string;
  seq: number;
  app_version: string;
  description: string | null;
  package_hash: string;
  blob_id: string | null;
  blob_url: string;
  manifest_blob_id: string | null;
  manifest_blob_url: string | null;
  diff_package_map: Record<string, SourceBlobInfo>;
  is_disabled: boolean;
  is_mandatory: boolean;
  rollout: number | null;
  size_bytes: number;
  release_method: string | null;
  original_deployment: string | null;
  original_label: string | null;
  released_by: string | null;
  uploaded_at: string;
}

interface BlobReference {
  blobId: string;
  sourceUrl: string;
  // Best-effort, from the export's container inventory; the copy re-measures.
  size: number;
  contentType: string;
  // True when this blob backs a deployment's CURRENT package -- losing one of
  // these is fatal, losing a historical one is not.
  isCurrent: boolean;
}

interface Flags {
  exportDir: string;
  confirm: boolean;
  merge: boolean;
  dryRun: boolean;
  skipBlobs: boolean;
  skipMetrics: boolean;
  allowMissingBlobs: boolean;
  allowMissingTimestamps: boolean;
  concurrency: number;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const counters: Record<string, number> = {};
const warnings: string[] = [];
const errors: string[] = [];

function bump(name: string, by = 1): void {
  counters[name] = (counters[name] || 0) + by;
}

function log(message: string): void {
  console.log(`[import-supabase] ${message}`);
}

function warn(message: string): void {
  warnings.push(message);
  console.warn(`[import-supabase] WARN  ${message}`);
}

function fail(message: string): void {
  errors.push(message);
  console.error(`[import-supabase] ERROR ${message}`);
}

// ── argv / env ───────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  const flags: Flags = {
    exportDir: "",
    confirm: false,
    merge: false,
    dryRun: false,
    skipBlobs: false,
    skipMetrics: false,
    allowMissingBlobs: false,
    allowMissingTimestamps: false,
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg: string = argv[i];
    switch (arg) {
      case "--confirm":
        flags.confirm = true;
        break;
      case "--merge":
        flags.merge = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--skip-blobs":
        flags.skipBlobs = true;
        break;
      case "--skip-metrics":
        flags.skipMetrics = true;
        break;
      case "--allow-missing-blobs":
        flags.allowMissingBlobs = true;
        break;
      case "--allow-missing-timestamps":
        flags.allowMissingTimestamps = true;
        break;
      case "--concurrency":
        flags.concurrency = parseInt(argv[++i], 10);
        break;
      default:
        if (arg.indexOf("--") === 0) {
          throw new Error(`Unknown flag '${arg}'. See the header of this file for usage.`);
        }
        positional.push(arg);
        break;
    }
  }

  if (positional.length !== 1) {
    throw new Error("Usage: node bin/script/scripts/import-supabase.js <export-dir> --confirm [flags]");
  }
  if (!flags.concurrency || flags.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  flags.exportDir = path.resolve(positional[0]);
  return flags;
}

function loadDotEnv(): void {
  // dotenv is a devDependency; the script must still run on a shell-provided
  // environment, so this is a guarded require rather than a top-level import.
  try {
    const dotenv = require("dotenv");
    dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env"), silent: true });
    dotenv.config({ path: path.resolve(process.cwd(), ".env"), silent: true });
  } catch (error) {
    log("dotenv not installed; reading configuration from the process environment only");
  }
}

function requireEnv(name: string): string {
  const value: string = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

// ── http ─────────────────────────────────────────────────────────────────────

/**
 * Per-request ceiling. A socket that goes quiet must FAIL, not hang.
 *
 * The 2026-09-07 dev import died at blob ~250/427 with ECONNRESET, and the
 * retry then sat with no output and no progress for minutes because nothing
 * bounded a stalled read. A crash is recoverable -- the importer is idempotent
 * -- but a hang gives an operator nothing to react to, and at prod scale
 * (4.93 GB) it is the difference between "re-run it" and "is it working?".
 */
const REQUEST_TIMEOUT_MS = 120000;

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
  redirectsLeft = 5
): Promise<HttpResponse> {
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
        timeout: REQUEST_TIMEOUT_MS,
        headers: body ? { ...headers, "Content-Length": String(body.length) } : headers,
      },
      (response: http.IncomingMessage) => {
        const status: number = response.statusCode || 0;
        const location: string = String(response.headers.location || "");
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          response.resume();
          httpRequest(method, new URL(location, url).toString(), headers, body, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      }
    );
    // `timeout` on the options only ARMS the timer; node does not abort the
    // request on its own. Without this listener the socket goes idle and the
    // promise never settles -- which is exactly the stall this constant exists
    // to prevent.
    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${url}`));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

/**
 * Transient network faults, which crossing two clouds with gigabytes of bundles
 * makes ordinary rather than exceptional.
 *
 * ECONNRESET is the one that stopped the 2026-09-07 dev import dead at blob
 * ~250 of 427 and abandoned the remaining 177 copies. A 5xx from either side is
 * the same class: retry it. A 4xx is NOT here on purpose -- a 404 on a bundle is
 * a real finding about the source data, and burning three retries on it would
 * only delay the error.
 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isTransient(error: unknown): boolean {
  const code: string = String((error as { code?: string })?.code || "");
  const message: string = String((error as Error)?.message || "");
  return (
    TRANSIENT_CODES.has(code) ||
    /socket hang up|timed out|ECONNRESET|EAI_AGAIN|network/i.test(message)
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * httpRequest plus bounded retry with exponential backoff.
 *
 * Retries the REQUEST, never the decision: a non-2xx response is returned to the
 * caller untouched so the existing missing-blob handling (which distinguishes a
 * deployment's CURRENT package from a historical one) still runs exactly as
 * before.
 */
async function httpRequestWithRetry(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
  attempts = 4
): Promise<HttpResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response: HttpResponse = await httpRequest(method, url, headers, body);
      // 5xx from Azure or Supabase is worth another go; 4xx is a real answer.
      if (response.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts) {
        throw error;
      }
      const backoff: number = 500 * 2 ** (attempt - 1);
      warn(`${method} ${url.slice(0, 90)} failed (${String((error as Error).message)}); retry ${attempt}/${attempts - 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

class SupabaseClient {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly dryRun: boolean;

  public constructor(baseUrl: string, serviceKey: string, dryRun: boolean) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.serviceKey = serviceKey;
    this.dryRun = dryRun;
  }

  public get publicBucketBase(): string {
    return `${this.baseUrl}/storage/v1/object/public/${BUCKET}`;
  }

  private restHeaders(prefer?: string): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (prefer) {
      headers.Prefer = prefer;
    }
    return headers;
  }

  public async select<T>(table: string, query: string): Promise<T[]> {
    const response: HttpResponse = await httpRequest("GET", `${this.baseUrl}/rest/v1/${table}?${query}`, this.restHeaders());
    if (response.status !== 200) {
      throw new Error(`SELECT ${table}?${query} -> ${response.status} ${response.body.toString("utf8")}`);
    }
    return JSON.parse(response.body.toString("utf8")) as T[];
  }

  public async count(table: string): Promise<number> {
    const response: HttpResponse = await httpRequest(
      "GET",
      `${this.baseUrl}/rest/v1/${table}?select=*&limit=1`,
      this.restHeaders("count=exact")
    );
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`COUNT ${table} -> ${response.status} ${response.body.toString("utf8")}`);
    }
    const range: string = String(response.headers["content-range"] || "");
    const total: string = range.split("/")[1] || "0";
    return parseInt(total, 10) || 0;
  }

  // PostgREST's merge-duplicates updates ONLY the columns present in the
  // payload, which is why several callers deliberately omit a column (see
  // label_counter in importDeployments).
  public async upsert<T>(table: string, onConflict: string, rows: object[], returning = false): Promise<T[]> {
    if (rows.length === 0) {
      return [];
    }
    if (this.dryRun) {
      return [];
    }
    const prefer: string = `resolution=merge-duplicates,return=${returning ? "representation" : "minimal"}`;
    const response: HttpResponse = await httpRequest(
      "POST",
      `${this.baseUrl}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      this.restHeaders(prefer),
      Buffer.from(JSON.stringify(rows), "utf8")
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`UPSERT ${table} (${rows.length} rows) -> ${response.status} ${response.body.toString("utf8")}`);
    }
    return returning ? (JSON.parse(response.body.toString("utf8")) as T[]) : [];
  }

  public async insert<T>(table: string, rows: object[], returning = false): Promise<T[]> {
    if (rows.length === 0) {
      return [];
    }
    if (this.dryRun) {
      return [];
    }
    const prefer: string = `return=${returning ? "representation" : "minimal"}`;
    const response: HttpResponse = await httpRequest(
      "POST",
      `${this.baseUrl}/rest/v1/${table}`,
      this.restHeaders(prefer),
      Buffer.from(JSON.stringify(rows), "utf8")
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`INSERT ${table} (${rows.length} rows) -> ${response.status} ${response.body.toString("utf8")}`);
    }
    return returning ? (JSON.parse(response.body.toString("utf8")) as T[]) : [];
  }

  public async patch(table: string, query: string, values: object): Promise<void> {
    if (this.dryRun) {
      return;
    }
    const response: HttpResponse = await httpRequest(
      "PATCH",
      `${this.baseUrl}/rest/v1/${table}?${query}`,
      this.restHeaders("return=minimal"),
      Buffer.from(JSON.stringify(values), "utf8")
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`PATCH ${table}?${query} -> ${response.status} ${response.body.toString("utf8")}`);
    }
  }

  public async objectExists(objectPath: string): Promise<boolean> {
    const response: HttpResponse = await httpRequest("HEAD", `${this.publicBucketBase}/${objectPath}`, {});
    return response.status === 200;
  }

  public async uploadObject(objectPath: string, body: Buffer, contentType: string): Promise<void> {
    if (this.dryRun) {
      return;
    }
    const response: HttpResponse = await httpRequest(
      "POST",
      `${this.baseUrl}/storage/v1/object/${BUCKET}/${objectPath}`,
      {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "true",
      },
      body
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`UPLOAD ${objectPath} -> ${response.status} ${response.body.toString("utf8")}`);
    }
  }
}

// ── export-dir helpers ───────────────────────────────────────────────────────

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function resolveRunDir(exportDir: string): string {
  if (fileExists(path.join(exportDir, "manifest.json"))) {
    return exportDir;
  }
  const latestPath: string = path.join(exportDir, "latest.json");
  if (fileExists(latestPath)) {
    const latest = readJson<{ run_dir: string; complete: boolean }>(latestPath);
    if (!latest.complete) {
      warn(`latest.json points at an INCOMPLETE run (${latest.run_dir}); re-run export-azure before importing`);
    }
    return latest.run_dir;
  }
  throw new Error(`${exportDir} is neither an export run directory nor a directory containing latest.json`);
}

function readEntities(runDir: string, kind: string): ClassifiedEntity[] {
  const filePath: string = path.join(runDir, "entities", `${kind}.json`);
  if (!fileExists(filePath)) {
    throw new Error(`Export is missing ${filePath}; re-run export-azure`);
  }
  return readJson<EntityFile>(filePath).items;
}

// ── value coercion ───────────────────────────────────────────────────────────

// Azure Tables hands epoch-millisecond values back as a number or, for Edm.Int64
// rows, as a bigint that export-azure serialised to a number (or to a string
// when it exceeded the safe-integer range).
function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed: number = Number(value);
    return isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoOrNull(value: unknown): string | null {
  const ms: number | null = toEpochMs(value);
  if (ms === null) {
    return null;
  }
  return new Date(ms).toISOString();
}

function requiredIso(value: unknown, what: string, flags: Flags): string | null {
  const iso: string | null = toIsoOrNull(value);
  if (iso === null) {
    const message = `${what} has no usable source timestamp; it would take DEFAULT now()`;
    if (flags.allowMissingTimestamps) {
      warn(message);
      bump("missing_timestamps");
      return null;
    }
    fail(`${message} (pass --allow-missing-timestamps to accept this)`);
    bump("missing_timestamps");
    return null;
  }
  return iso;
}

function toBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

/**
 * Remove any `*_at` key whose value is null before the row reaches PostgREST.
 *
 * WHY THIS IS NOT COSMETIC: PostgREST passes an explicit JSON null straight
 * through to the INSERT. A key that is PRESENT and null does NOT fall back to
 * the column DEFAULT -- only an ABSENT key does. Every timestamp column in 803
 * is `NOT NULL DEFAULT now()`, so a row whose source timestamp is missing must
 * omit the key entirely: sending null raises 23502 and, because these writes are
 * batched, takes every other row in the same POST down with it.
 *
 * That is exactly the path `--allow-missing-timestamps` exists to enable. Without
 * this, the flag's documented behaviour (invariant #3 -- warn, take DEFAULT now(),
 * carry on) was unreachable and the flag aborted the import instead. `expires_at`
 * can never arrive here as null (a key with no `expires` is rejected outright,
 * because a NOT NULL default would silently revoke a live token rather than lose
 * a display date).
 */
function withoutNullTimestamps<T extends object>(row: T): T {
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    if (copy[key] === null && key.length > 3 && key.slice(-3) === "_at") {
      delete copy[key];
    }
  }
  return copy as T;
}

// blobId is the LAST path segment of the persisted URL (azure-storage.ts:809-814
// returns the container URL + blobId with no SAS). Preserving it end to end is
// what makes the blob copy re-runnable and what keeps codepush_blob.id equal to
// the generateSecureKey() value the server minted.
function blobIdFromUrl(url: string): string | null {
  try {
    const segments: string[] = new URL(url).pathname.split("/").filter((segment: string) => segment.length > 0);
    const last: string = segments[segments.length - 1] || "";
    return last.length > 0 ? decodeURIComponent(last) : null;
  } catch (error) {
    return null;
  }
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let slot = 0; slot < Math.min(limit, items.length); slot++) {
    runners.push(
      (async (): Promise<void> => {
        for (;;) {
          const index: number = cursor++;
          if (index >= items.length) {
            return;
          }
          await worker(items[index], index);
        }
      })()
    );
  }
  await Promise.all(runners);
}

// ── step 1: accounts ─────────────────────────────────────────────────────────

async function importAccounts(client: SupabaseClient, runDir: string, flags: Flags): Promise<Map<string, string>> {
  const accounts: ClassifiedEntity[] = readEntities(runDir, "account");
  const emailToAccountId: Map<string, string> = new Map<string, string>();
  const rows: object[] = [];

  for (const item of accounts) {
    const entity: RawEntity = item.entity;
    const id: string = String(entity.id || "");
    const email: string = String(entity.email || item.email || "");
    if (!id || !email) {
      fail(`Account row ${entity.partitionKey}/${entity.rowKey} has no id or no email`);
      continue;
    }
    emailToAccountId.set(email.toLowerCase(), id);
    rows.push({
      id,
      // ORIGINAL casing preserved; 803's uniqueness is on lower(email), which is
      // what Azure's email partition key did (azure-storage.ts:105-107).
      email,
      name: String(entity.name || email),
      github_id: toStringOrNull(entity.gitHubId),
      microsoft_id: toStringOrNull(entity.microsoftId),
      azure_ad_id: toStringOrNull(entity.azureAdId),
      created_at: requiredIso(entity.createdTime, `account ${id} (${email})`, flags),
    });
  }

  // A lower(email) collision would abort the whole insert on a unique index; say
  // which two rows collided rather than handing over a bare 23505.
  const seenLowerEmails: Map<string, string> = new Map<string, string>();
  for (const row of rows as { id: string; email: string }[]) {
    const lower: string = row.email.toLowerCase();
    const previous: string = seenLowerEmails.get(lower);
    if (previous) {
      fail(`Two accounts differ only by email casing: ${previous} and ${row.id} both map to '${lower}'`);
    }
    seenLowerEmails.set(lower, row.id);
  }

  await client.upsert("codepush_account", "id", rows.map(withoutNullTimestamps));
  bump("accounts", rows.length);
  log(`accounts: ${rows.length}`);
  return emailToAccountId;
}

// ── step 2: access keys ──────────────────────────────────────────────────────

async function importAccessKeys(client: SupabaseClient, runDir: string, accountIds: Set<string>, flags: Flags): Promise<void> {
  const keys: ClassifiedEntity[] = readEntities(runDir, "access_key");
  const rows: object[] = [];

  for (const item of keys) {
    const entity: RawEntity = item.entity;
    const id: string = String(entity.id || item.accessKeyId || "");
    const accountId: string = item.accountId || "";
    // `name` on this row is ALREADY sha256(plaintext) -- insertAccessKey hashes
    // it before the write (azure-storage.ts:1236-1239). Copying it verbatim is
    // what keeps every issued token valid.
    const nameHash: string = String(entity.name || "");
    const expiresAt: string | null = toIsoOrNull(entity.expires);

    if (!id || !accountId || !nameHash) {
      fail(`Access key row ${entity.partitionKey}/${entity.rowKey} is missing id, accountId or name hash`);
      continue;
    }
    if (!accountIds.has(accountId)) {
      fail(`Access key ${id} references account ${accountId}, which is not in the export`);
      continue;
    }
    if (!expiresAt) {
      // expires_at is NOT NULL in 803 and dropping the row silently revokes a
      // token someone is using right now.
      fail(`Access key ${id} (account ${accountId}) has no 'expires' value; refusing to invent one`);
      continue;
    }

    rows.push({
      id,
      account_id: accountId,
      name_hash: nameHash,
      friendly_name: String(entity.friendlyName || id),
      description: toStringOrNull(entity.description),
      created_by: toStringOrNull(entity.createdBy),
      is_session: toBool(entity.isSession),
      created_at: requiredIso(entity.createdTime, `access key ${id}`, flags),
      expires_at: expiresAt,
    });
  }

  await client.upsert("codepush_access_key", "id", rows.map(withoutNullTimestamps));
  bump("access_keys", rows.length);
  log(`access keys: ${rows.length}`);
}

// ── step 3: apps + collaborators ─────────────────────────────────────────────

async function importApps(
  client: SupabaseClient,
  runDir: string,
  accountIds: Set<string>,
  emailToAccountId: Map<string, string>,
  flags: Flags
): Promise<void> {
  const apps: ClassifiedEntity[] = readEntities(runDir, "app");
  const appRows: object[] = [];
  const collaboratorRows: object[] = [];

  for (const item of apps) {
    const entity: RawEntity = item.entity;
    const id: string = String(entity.id || item.appId || "");
    const name: string = String(entity.name || "");
    if (!id || !name) {
      fail(`App row ${entity.partitionKey}/${entity.rowKey} has no id or no name`);
      continue;
    }

    appRows.push({
      id,
      // CASE-SENSITIVE on purpose: findAppByName compares with === so 'MyApp'
      // and 'myapp' are two legal apps today (storage.ts:277).
      name,
      created_at: requiredIso(entity.createdTime, `app ${id} (${name})`, flags),
    });

    // collaborators is a JSON STRING on the app row (azure-storage.ts:1478-1495).
    let collaborators: Record<string, SourceCollaborator> = {};
    if (entity.collaborators) {
      try {
        collaborators = JSON.parse(String(entity.collaborators)) as Record<string, SourceCollaborator>;
      } catch (error) {
        fail(`App ${id} (${name}) has an unparseable collaborators JSON string`);
        continue;
      }
    }

    for (const email of Object.keys(collaborators)) {
      const collaborator: SourceCollaborator = collaborators[email];
      // isCurrentAccount is computed per request and must never be persisted
      // (azure-storage.ts:1465-1471); we simply never read it here.
      const permission: string = String(collaborator.permission || "");
      if (permission !== "Owner" && permission !== "Collaborator") {
        fail(`App ${id} (${name}) collaborator ${email} has permission '${permission}', which is not in the enum`);
        continue;
      }

      // accountId is marked /*generated*/ and optional (storage.ts:49), so a
      // grant can legitimately carry no id. Resolve by lower(email); a grant we
      // cannot resolve decides who may release to Production, so it is an error,
      // never a silent drop.
      let accountId: string = collaborator.accountId || "";
      if (!accountId || !accountIds.has(accountId)) {
        const resolved: string = emailToAccountId.get(email.toLowerCase()) || "";
        if (!resolved) {
          fail(
            `App ${id} (${name}) grants ${permission} to '${email}' but its accountId ` +
              `('${accountId || "none"}') is unknown and the email matches no exported account`
          );
          continue;
        }
        warn(`App ${id} (${name}): resolved collaborator '${email}' to account ${resolved} by email`);
        bump("collaborators_resolved_by_email");
        accountId = resolved;
      }

      collaboratorRows.push({
        app_id: id,
        account_id: accountId,
        email,
        permission,
        // NOT NULL, but 803's BEFORE INSERT trigger overwrites it from
        // codepush_app.name anyway -- this value only has to be present.
        app_name: name,
        created_at: requiredIso(entity.createdTime, `collaborator ${email} on app ${id}`, flags),
      });
    }
  }

  await client.upsert("codepush_app", "id", appRows.map(withoutNullTimestamps));
  bump("apps", appRows.length);
  await client.upsert("codepush_app_collaborator", "app_id,account_id", collaboratorRows.map(withoutNullTimestamps));
  bump("collaborators", collaboratorRows.length);
  log(`apps: ${appRows.length}, collaborators: ${collaboratorRows.length}`);
}

// ── step 4: deployments ──────────────────────────────────────────────────────

async function importDeployments(
  client: SupabaseClient,
  runDir: string,
  appIds: Set<string>,
  flags: Flags
): Promise<ClassifiedEntity[]> {
  const deployments: ClassifiedEntity[] = readEntities(runDir, "deployment");
  const rows: object[] = [];
  const accepted: ClassifiedEntity[] = [];

  for (const item of deployments) {
    const entity: RawEntity = item.entity;
    const id: string = String(entity.id || item.deploymentId || "");
    const appId: string = item.appId || "";
    const name: string = String(entity.name || "");
    const key: string = String(entity.key || "");

    if (!id || !appId || !name || !key) {
      fail(`Deployment row ${entity.partitionKey}/${entity.rowKey} is missing id, appId, name or key`);
      continue;
    }
    if (!appIds.has(appId)) {
      fail(`Deployment ${id} (${name}) references app ${appId}, which is not in the export`);
      continue;
    }

    rows.push({
      id,
      app_id: appId,
      name,
      // VERBATIM. Asserted after the write, below.
      deployment_key: key,
      created_at: requiredIso(entity.createdTime, `deployment ${id} (${name})`, flags),
      // label_counter is deliberately ABSENT from this payload. PostgREST's
      // merge-duplicates only updates the columns it is given, so an insert
      // takes the DEFAULT 0 and a re-run leaves the counter the package step
      // computed rather than resetting it to zero.
    });
    accepted.push(item);
  }

  await client.upsert("codepush_deployment", "id", rows.map(withoutNullTimestamps));
  bump("deployments", rows.length);
  log(`deployments: ${rows.length}`);

  // ASSERT rather than trust. A regenerated or mangled key strands every device
  // compiled against it, with no OTA path to fix it -- this is the one check
  // worth a round trip.
  if (!flags.dryRun && rows.length > 0) {
    const stored = await client.select<{ id: string; deployment_key: string }>(
      "codepush_deployment",
      "select=id,deployment_key&limit=10000"
    );
    const storedById: Map<string, string> = new Map<string, string>();
    for (const row of stored) {
      storedById.set(row.id, row.deployment_key);
    }
    for (const row of rows as { id: string; deployment_key: string; name?: string }[]) {
      const actual: string = storedById.get(row.id);
      if (actual !== row.deployment_key) {
        fail(
          `DEPLOYMENT KEY MISMATCH for ${row.id}: export has '${row.deployment_key}', ` +
            `database has '${actual === undefined ? "(row missing)" : actual}'`
        );
      }
    }
    log(`deployment keys verified byte-for-byte: ${rows.length}`);
  }

  return accepted;
}

// ── step 5: packages (blobs first, then rows) ────────────────────────────────

function parsePackagesForDeployment(runDir: string, deployment: ClassifiedEntity): SourcePackage[] {
  const deploymentId: string = deployment.deploymentId || String(deployment.entity.id || "");
  const historyPath: string = path.join(runDir, "package-history", `${deploymentId}.json`);

  if (fileExists(historyPath)) {
    const history: HistoryFile = readJson<HistoryFile>(historyPath);
    if (history.packages.length > 0) {
      return history.packages;
    }
  }

  // Fall back to the LATEST package cached as a JSON string on the deployment
  // row (azure-storage.ts:742-743). This is the only thing standing between a
  // deployment whose history blob was lost and a deployment with no current
  // release at all.
  if (deployment.entity.package) {
    try {
      const latest: SourcePackage = JSON.parse(String(deployment.entity.package)) as SourcePackage;
      warn(`Deployment ${deploymentId} has no history blob; recovering only its current package from the deployment row`);
      bump("deployments_recovered_from_row_package");
      return [latest];
    } catch (error) {
      fail(`Deployment ${deploymentId} has an unparseable 'package' JSON string on its row`);
    }
  }

  return [];
}

// seq is DERIVED FROM THE LABEL, never from the array index. The history blob is
// a rolling window trimmed from the front, so index+1 renumbers every release
// each time the window slides -- which both corrupts the label ordering and
// makes the import non-re-runnable (a row that was index 5 becomes index 4 and
// 23505s the (deployment_id, seq) unique index).
function deriveSeq(label: string, previousMax: number): number {
  const match: RegExpMatchArray = label.match(/^v(\d+)$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return previousMax + 1;
}

interface PreparedDeployment {
  deploymentId: string;
  rows: PackageRow[];
  labelCounter: number;
  diffBlobs: Map<string, { blobId: string; sourceHash: string }[]>;
}

function prepareDeployment(
  runDir: string,
  deployment: ClassifiedEntity,
  blobRefs: Map<string, BlobReference>,
  inventory: Map<string, { size: number; contentType: string }>,
  publicBase: string,
  flags: Flags
): PreparedDeployment {
  const deploymentId: string = deployment.deploymentId || String(deployment.entity.id || "");
  const packages: SourcePackage[] = parsePackagesForDeployment(runDir, deployment);
  const rows: PackageRow[] = [];
  const diffBlobs: Map<string, { blobId: string; sourceHash: string }[]> = new Map();
  const seenSeq: Map<number, string> = new Map<number, string>();
  let maxSeq = 0;
  let maxLabelSuffix = 0;

  const noteBlob = (url: string, isCurrent: boolean): { blobId: string | null; url: string } => {
    const blobId: string | null = blobIdFromUrl(url);
    if (!blobId) {
      fail(`Deployment ${deploymentId}: cannot read a blob id out of URL '${url}'`);
      return { blobId: null, url };
    }
    const known = inventory.get(blobId);
    const existing: BlobReference = blobRefs.get(blobId);
    if (existing) {
      existing.isCurrent = existing.isCurrent || isCurrent;
    } else {
      blobRefs.set(blobId, {
        blobId,
        sourceUrl: url,
        size: known ? known.size : 0,
        contentType: known ? known.contentType : "",
        isCurrent,
      });
    }
    return { blobId, url: `${publicBase}/${BLOB_PREFIX}${blobId}` };
  };

  packages.forEach((sourcePackage: SourcePackage, index: number) => {
    const label: string = String(sourcePackage.label || "");
    if (!label) {
      fail(`Deployment ${deploymentId}: package at history index ${index} has no label`);
      return;
    }
    const isCurrent: boolean = index === packages.length - 1;
    const seq: number = deriveSeq(label, maxSeq);
    const collision: string = seenSeq.get(seq);
    if (collision) {
      fail(`Deployment ${deploymentId}: labels '${collision}' and '${label}' both derive seq ${seq}`);
      return;
    }
    seenSeq.set(seq, label);
    maxSeq = Math.max(maxSeq, seq);

    const labelMatch: RegExpMatchArray = label.match(/^v(\d+)$/);
    if (labelMatch) {
      maxLabelSuffix = Math.max(maxLabelSuffix, parseInt(labelMatch[1], 10));
    }

    const bundle = noteBlob(String(sourcePackage.blobUrl || ""), isCurrent);
    const manifest = sourcePackage.manifestBlobUrl
      ? noteBlob(String(sourcePackage.manifestBlobUrl), isCurrent)
      : { blobId: null, url: null };

    // The diff map's URLs are persisted inside the JSONB column AND mirrored
    // into codepush_package_diff_blob, which is the only thing that makes "is
    // this blob still referenced?" a cheap query for the GC sweep.
    const rewrittenDiffMap: Record<string, SourceBlobInfo> = {};
    const diffRefs: { blobId: string; sourceHash: string }[] = [];
    const sourceDiffMap: Record<string, SourceBlobInfo> = sourcePackage.diffPackageMap || {};
    for (const sourceHash of Object.keys(sourceDiffMap)) {
      const diffInfo: SourceBlobInfo = sourceDiffMap[sourceHash];
      const rewritten = noteBlob(String(diffInfo.url || ""), isCurrent);
      rewrittenDiffMap[sourceHash] = { size: diffInfo.size, url: rewritten.url };
      if (rewritten.blobId) {
        diffRefs.push({ blobId: rewritten.blobId, sourceHash });
      }
    }
    diffBlobs.set(label, diffRefs);

    const uploadedAt: string | null = requiredIso(sourcePackage.uploadTime, `package ${label} of deployment ${deploymentId}`, flags);

    const releaseMethod: string | null = toStringOrNull(sourcePackage.releaseMethod);
    if (releaseMethod && ["Upload", "Promote", "Rollback"].indexOf(releaseMethod) < 0) {
      // 803 keeps release_method as TEXT + CHECK precisely so one odd historical
      // value cannot 22P02 the import -- but it will still violate the CHECK, so
      // say which row before the database does.
      fail(`Deployment ${deploymentId} package ${label} has releaseMethod '${releaseMethod}', outside the CHECK constraint`);
    }

    rows.push({
      deployment_id: deploymentId,
      label,
      seq,
      app_version: String(sourcePackage.appVersion || ""),
      description: toStringOrNull(sourcePackage.description),
      package_hash: String(sourcePackage.packageHash || ""),
      blob_id: bundle.blobId,
      blob_url: bundle.url,
      manifest_blob_id: manifest.blobId,
      manifest_blob_url: manifest.url,
      diff_package_map: rewrittenDiffMap,
      is_disabled: toBool(sourcePackage.isDisabled),
      is_mandatory: toBool(sourcePackage.isMandatory),
      rollout: typeof sourcePackage.rollout === "number" ? sourcePackage.rollout : null,
      size_bytes: typeof sourcePackage.size === "number" ? sourcePackage.size : 0,
      release_method: releaseMethod,
      original_deployment: toStringOrNull(sourcePackage.originalDeployment),
      original_label: toStringOrNull(sourcePackage.originalLabel),
      released_by: toStringOrNull(sourcePackage.releasedBy),
      uploaded_at: uploadedAt,
    });
  });

  return {
    deploymentId,
    rows,
    // GREATEST(max(seq), max label suffix) -- the two differ only when a label
    // did not parse as v<N> and took max+1 instead.
    labelCounter: Math.max(maxSeq, maxLabelSuffix),
    diffBlobs,
  };
}

async function copyBlobs(client: SupabaseClient, blobRefs: Map<string, BlobReference>, flags: Flags): Promise<Set<string>> {
  const copied: Set<string> = new Set<string>();
  if (flags.skipBlobs) {
    log(`blob copy skipped (--skip-blobs); ${blobRefs.size} blob(s) referenced`);
    return copied;
  }

  const existingLedger: Set<string> = new Set<string>();
  if (!flags.dryRun) {
    const ledgerRows = await client.select<{ id: string }>("codepush_blob", "select=id&limit=100000");
    for (const row of ledgerRows) {
      existingLedger.add(row.id);
    }
  }

  const refs: BlobReference[] = Array.from(blobRefs.values());
  const ledgerRows: object[] = [];
  let done = 0;

  await mapWithConcurrency(refs, flags.concurrency, async (ref: BlobReference) => {
    const objectPath: string = `${BLOB_PREFIX}${ref.blobId}`;
    done++;
    if (done % 25 === 0) {
      log(`  ...blobs ${done}/${refs.length}`);
    }

    // THE OBJECT IS THE AUTHORITY, NOT THE LEDGER ROW.
    //
    // This used to require BOTH (`existingLedger.has(id) && objectExists(...)`),
    // with the sound-looking reasoning that a ledger row without an object is a
    // package pointing at a 404. The reasoning is right; the conjunction was
    // wrong, because ledger rows are written in ONE batch after every copy
    // finishes. A run that dies partway therefore leaves 250 objects in the
    // bucket and ZERO ledger rows -- so on the re-run every one of them missed
    // the skip and was downloaded and re-uploaded from scratch. That is exactly
    // what happened on 2026-09-07, and at 4.93 GB it turns a resume into a
    // full restart.
    //
    // Checking the OBJECT alone is both cheaper and safer: an object with no
    // ledger row is re-registered below (the ledger row is still queued), while
    // a ledger row with no object is re-copied rather than trusted. Neither
    // direction can leave a package row pointing at a 404.
    if (await client.objectExists(objectPath)) {
      if (!existingLedger.has(ref.blobId)) {
        // Present in the bucket from an interrupted run, but never registered.
        ledgerRows.push({
          id: ref.blobId,
          bucket: BUCKET,
          storage_path: objectPath,
          size_bytes: ref.size || 0,
          content_type: ref.contentType || "application/octet-stream",
          created_at: null,
        });
      }
      copied.add(ref.blobId);
      bump("blobs_already_present");
      return;
    }

    // Anonymous GET: the Azure container is created with {access:"blob"}
    // (azure-storage.ts:1001) and getBlobUrl returns a bare URL with no SAS, so
    // this half of the migration needs no Azure credential at all.
    const response: HttpResponse = await httpRequestWithRetry("GET", ref.sourceUrl, {});
    if (response.status !== 200) {
      const message = `Blob ${ref.blobId} is not readable at ${ref.sourceUrl} (HTTP ${response.status})`;
      if (ref.isCurrent && !flags.allowMissingBlobs) {
        fail(`${message} -- and it backs a deployment's CURRENT package`);
      } else if (flags.allowMissingBlobs || !ref.isCurrent) {
        warn(`${message}; the package row will keep its rewritten URL and no ledger row`);
      } else {
        fail(message);
      }
      bump("blobs_missing");
      return;
    }

    const contentType: string = ref.contentType || String(response.headers["content-type"] || "application/octet-stream");
    await client.uploadObject(objectPath, response.body, contentType);
    ledgerRows.push({
      id: ref.blobId,
      bucket: BUCKET,
      storage_path: objectPath,
      size_bytes: response.body.length,
      content_type: contentType,
      // account_id stays null: nothing in the Azure record says which account
      // uploaded a historical blob.
      created_at: null,
    });
    copied.add(ref.blobId);
    bump("blobs_copied");
    bump("blob_bytes_copied", response.body.length);
  });

  // created_at is DROPPED from the payload rather than sent as null: the column
  // is NOT NULL DEFAULT now() and a blob's upload time is not recorded anywhere
  // in the Azure table. The package's uploaded_at is the timestamp that matters.
  const cleanRows: object[] = ledgerRows.map(withoutNullTimestamps);

  for (let offset = 0; offset < cleanRows.length; offset += 500) {
    await client.upsert("codepush_blob", "id", cleanRows.slice(offset, offset + 500));
  }
  log(
    `blobs: ${counters.blobs_copied || 0} copied, ${counters.blobs_already_present || 0} already present, ${
      counters.blobs_missing || 0
    } missing`
  );
  return copied;
}

async function writePackages(
  client: SupabaseClient,
  prepared: PreparedDeployment[],
  copiedBlobs: Set<string>,
  flags: Flags
): Promise<void> {
  for (const deployment of prepared) {
    if (deployment.rows.length === 0) {
      // Normal, not a fault: a Staging channel that has never been released to
      // has an empty history blob and no `package` on its row. Verified against
      // the live account 2026-09-07: 25 of 40 deployments are in this state, so
      // this must not be a warning or it buries the ones that matter.
      bump("deployments_with_no_packages");
      continue;
    }

    // A blob we could not copy must not leave a dangling FK. The URL still gets
    // rewritten (it is the address the object WILL have if it is ever restored);
    // only the ledger reference is dropped.
    for (const row of deployment.rows) {
      if (row.blob_id && !copiedBlobs.has(row.blob_id)) {
        row.blob_id = null;
      }
      if (row.manifest_blob_id && !copiedBlobs.has(row.manifest_blob_id)) {
        row.manifest_blob_id = null;
      }
    }

    const existing = flags.dryRun
      ? []
      : await client.select<{ id: number; label: string; seq: number }>(
          "codepush_package",
          `select=id,label,seq&deployment_id=eq.${encodeURIComponent(deployment.deploymentId)}&limit=10000`
        );
    const existingByLabel: Map<string, { id: number; seq: number }> = new Map<string, { id: number; seq: number }>();
    for (const row of existing) {
      existingByLabel.set(row.label, { id: row.id, seq: row.seq });
    }

    const toInsert: PackageRow[] = [];
    const labelToPackageId: Map<string, number> = new Map<string, number>();

    for (const row of deployment.rows) {
      const found = existingByLabel.get(row.label);
      if (!found) {
        toInsert.push(row);
        continue;
      }
      labelToPackageId.set(row.label, found.id);
      // UPDATE every column EXCEPT seq. seq is only deterministic for labels
      // that parse as v<N>; for the rest it was max+1 at the time of the first
      // run, and re-deriving it against a slid window would renumber the row
      // under a unique index that forbids the collision.
      const patch: Record<string, unknown> = { ...row };
      delete patch.seq;
      delete patch.deployment_id;
      delete patch.label;
      await client.patch(
        "codepush_package",
        `deployment_id=eq.${encodeURIComponent(deployment.deploymentId)}&label=eq.${encodeURIComponent(row.label)}`,
        withoutNullTimestamps(patch)
      );
      bump("packages_updated");
    }

    if (toInsert.length > 0) {
      const inserted = await client.insert<{ id: number; label: string }>(
        "codepush_package",
        toInsert.map(withoutNullTimestamps),
        true
      );
      for (const row of inserted) {
        labelToPackageId.set(row.label, row.id);
      }
      bump("packages_inserted", toInsert.length);
    }

    // Diff-blob child rows, once the package ids are known.
    const diffRows: object[] = [];
    for (const label of Array.from(deployment.diffBlobs.keys())) {
      const packageId: number = labelToPackageId.get(label);
      if (packageId === undefined) {
        continue;
      }
      for (const ref of deployment.diffBlobs.get(label)) {
        if (!copiedBlobs.has(ref.blobId)) {
          continue;
        }
        diffRows.push({ package_id: packageId, blob_id: ref.blobId, source_package_hash: ref.sourceHash });
      }
    }
    await client.upsert("codepush_package_diff_blob", "package_id,source_package_hash", diffRows);
    bump("package_diff_blobs", diffRows.length);

    // label_counter LAST, and only ever upward. If a release landed on the new
    // server between two runs of this importer, the live counter is ahead of the
    // Azure snapshot and must win.
    if (!flags.dryRun) {
      const current = await client.select<{ label_counter: number }>(
        "codepush_deployment",
        `select=label_counter&id=eq.${encodeURIComponent(deployment.deploymentId)}`
      );
      const live: number = current.length > 0 ? current[0].label_counter : 0;
      const target: number = Math.max(live, deployment.labelCounter);
      if (target !== live) {
        await client.patch("codepush_deployment", `id=eq.${encodeURIComponent(deployment.deploymentId)}`, {
          label_counter: target,
        });
      }
      bump("label_counters_set");
    }
  }

  log(
    `packages: ${counters.packages_inserted || 0} inserted, ${counters.packages_updated || 0} updated, ` +
      `${counters.package_diff_blobs || 0} diff-blob links`
  );
}

// ── step 6: metrics ──────────────────────────────────────────────────────────

async function importMetrics(client: SupabaseClient, runDir: string, deployments: ClassifiedEntity[]): Promise<void> {
  const metricsPath: string = path.join(runDir, "redis-metrics.json");
  if (!fileExists(metricsPath)) {
    warn(`No redis-metrics.json in the export -- deployment metrics are the ONLY copy and cannot be re-derived`);
    return;
  }

  const metrics: RedisMetricsFile = readJson<RedisMetricsFile>(metricsPath);
  const keyToDeploymentId: Map<string, string> = new Map<string, string>();
  for (const deployment of deployments) {
    const key: string = String(deployment.entity.key || "");
    const id: string = deployment.deploymentId || String(deployment.entity.id || "");
    if (key && id) {
      keyToDeploymentId.set(key, id);
    }
  }

  const rows: object[] = [];
  for (const deploymentKey of Object.keys(metrics.hashes)) {
    const deploymentId: string = keyToDeploymentId.get(deploymentKey);
    if (!deploymentId) {
      const fields: number = Object.keys(metrics.hashes[deploymentKey]).length;
      if (fields > 0) {
        warn(`Redis holds ${fields} metric field(s) for deployment key '${deploymentKey}', which no exported deployment owns`);
        bump("metric_hashes_orphaned");
      }
      continue;
    }

    const hash: Record<string, number> = metrics.hashes[deploymentKey];
    for (const field of Object.keys(hash)) {
      // Field is "<label>:<status>". Split on the LAST colon: labels are v<N>
      // today, but a label is free-form text as far as this parser is concerned
      // and the status suffix is the part with a fixed vocabulary.
      const separator: number = field.lastIndexOf(":");
      if (separator <= 0) {
        warn(`Metric field '${field}' on key '${deploymentKey}' is not '<label>:<status>'; skipped`);
        continue;
      }
      rows.push({
        deployment_id: deploymentId,
        label: field.substring(0, separator),
        status: field.substring(separator + 1),
        // ABSOLUTE, not a delta. codepush_bump_metrics ADDS and is deliberately
        // not used here -- a second import would otherwise double every counter.
        count: hash[field],
      });
    }
  }

  for (let offset = 0; offset < rows.length; offset += 500) {
    await client.upsert("codepush_deployment_metric", "deployment_id,label,status", rows.slice(offset, offset + 500));
  }
  bump("metrics", rows.length);
  log(`metrics: ${rows.length} (deployment_id, label, status) counters`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags: Flags = parseFlags(process.argv.slice(2));
  loadDotEnv();

  if (!flags.confirm) {
    throw new Error(
      "Refusing to run without --confirm. This script WRITES to Supabase " +
        "(codepush_* tables and the LazyWaitCodePush bucket). Re-run with --confirm, " +
        "or with --dry-run --confirm to validate the export without writing."
    );
  }

  const supabaseUrl: string = requireEnv("SUPABASE_URL");
  const serviceKey: string = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const client: SupabaseClient = new SupabaseClient(supabaseUrl, serviceKey, flags.dryRun);

  const runDir: string = resolveRunDir(flags.exportDir);
  log(`export ${runDir}`);
  log(`target ${supabaseUrl}${flags.dryRun ? "  (DRY RUN -- nothing will be written)" : ""}`);

  // Pre-flight: never write into a project that already holds codepush rows
  // unless the operator said so. An accidental second import against a live
  // project is how metrics get clobbered and label counters get walked back.
  const existingCounts: Record<string, number> = {};
  let populated = 0;
  for (const table of CODEPUSH_TABLES) {
    const rows: number = await client.count(table);
    existingCounts[table] = rows;
    populated += rows;
  }
  if (populated > 0) {
    const summary: string = CODEPUSH_TABLES.filter((table: string) => existingCounts[table] > 0)
      .map((table: string) => `${table}=${existingCounts[table]}`)
      .join(" ");
    if (!flags.merge) {
      throw new Error(
        `The target project already holds codepush rows (${summary}). ` +
          "Re-run with --merge to import into a populated project, or drop the rows first. " +
          "NOTE: --merge with metrics enabled overwrites live counters with the frozen Azure snapshot; " +
          "add --skip-metrics on any post-cutover re-run."
      );
    }
    log(`--merge: target already holds ${summary}`);
  }

  const emailToAccountId: Map<string, string> = await importAccounts(client, runDir, flags);
  const accountIds: Set<string> = new Set<string>(Array.from(emailToAccountId.values()));

  await importAccessKeys(client, runDir, accountIds, flags);

  const apps: ClassifiedEntity[] = readEntities(runDir, "app");
  const appIds: Set<string> = new Set<string>(
    apps.map((item: ClassifiedEntity) => String(item.entity.id || item.appId || "")).filter((id: string) => id.length > 0)
  );
  await importApps(client, runDir, accountIds, emailToAccountId, flags);

  const deployments: ClassifiedEntity[] = await importDeployments(client, runDir, appIds, flags);

  // Blob inventory gives the content type and size without a HEAD per object.
  const inventory: Map<string, { size: number; contentType: string }> = new Map();
  const inventoryPath: string = path.join(runDir, "blobs-storagev2.json");
  if (fileExists(inventoryPath)) {
    const file: BlobInventoryFile = readJson<BlobInventoryFile>(inventoryPath);
    for (const item of file.items) {
      inventory.set(item.name, { size: item.size, contentType: item.content_type });
    }
  } else {
    warn("Export has no blobs-storagev2.json; content types will be taken from the Azure response headers");
  }

  const blobRefs: Map<string, BlobReference> = new Map<string, BlobReference>();
  const prepared: PreparedDeployment[] = deployments.map((deployment: ClassifiedEntity) =>
    prepareDeployment(runDir, deployment, blobRefs, inventory, client.publicBucketBase, flags)
  );

  // Blobs BEFORE package rows: codepush_package.blob_id FKs into codepush_blob.
  const copiedBlobs: Set<string> = await copyBlobs(client, blobRefs, flags);
  await writePackages(client, prepared, copiedBlobs, flags);

  if (flags.skipMetrics) {
    log("metrics skipped (--skip-metrics)");
  } else {
    await importMetrics(client, runDir, deployments);
  }

  log("---- summary ----");
  for (const key of Object.keys(counters).sort()) {
    log(`  ${key.padEnd(34)} ${counters[key]}`);
  }
  log(`  ${"warnings".padEnd(34)} ${warnings.length}`);
  log(`  ${"errors".padEnd(34)} ${errors.length}`);

  if (errors.length > 0) {
    console.error("[import-supabase] FAILED with the errors above. Fix the source data and re-run; the importer is idempotent.");
    process.exit(1);
  }
  log(flags.dryRun ? "dry run complete -- nothing was written" : "import complete");
}

main().catch((error: Error) => {
  console.error("[import-supabase] FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
