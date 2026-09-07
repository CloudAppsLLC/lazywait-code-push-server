// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// export-azure.ts -- READ-ONLY snapshot of everything this service keeps in Azure.
//
// WHY THIS EXISTS
// ---------------
// The CodePush data layer is ONE Azure Table ("storagev2") plus two blob
// containers, and a Redis instance that is the ONLY copy of the deployment
// metrics. Nothing in this repo can re-derive either:
//
//   * The table holds nine distinct row shapes keyed by a hand-rolled
//     "PartitionKey RowKey" grammar (azure-storage.ts:24-140). Six of those row
//     shapes are hand-built secondary indexes; three carry the real data. Read
//     verbatim, they are the only record of who owns which app, which access
//     token hash opens the management API, and -- critically -- which
//     deployment key is compiled into which shipped binary.
//   * `packagehistoryv1/<deploymentId>` holds the release history as a JSON
//     blob. It is a ROLLING WINDOW of the last 50 releases trimmed from the
//     FRONT (azure-storage.ts:739-740) while labels keep counting up
//     (:1402-1410), so a deployment with 86 releases holds labels v37..v86.
//     Both facts matter to the importer and neither is recoverable once the
//     account is deleted.
//   * Redis DB 1 holds `deploymentKeyLabels:<key>` -- the per-label install and
//     status counters. `grep -rn metric api/script/storage` returns zero hits:
//     nothing else ever saw these numbers. Status reports are fire-and-forget
//     (routes/acquisition.ts), so a lost counter is lost for good, and worse
//     than zeroed: recordUpdate DECREMENTS the previous label
//     (redis-manager.ts:257-261), so an empty Active counter drifts permanently
//     negative once the fleet starts reporting again.
//
// THIS SCRIPT NEVER WRITES TO AZURE. No createTable, no createEntity, no
// uploadBlockBlob, no DEL. It opens the table client directly rather than going
// through AzureStorage, whose constructor CREATES the table, both containers and
// three health entities as a side effect of `setup()` (azure-storage.ts:998-1012)
// -- an export must not be able to resurrect a container someone just deleted.
//
// It also does not go through AzureStorage.unwrap(), which destructures
// `createdTime` away and re-adds it ONLY when it arrives as a bigint
// (azure-storage.ts:1108-1120). Every timestamp in the export would be dropped
// on the floor for rows whose createdTime came back as an Edm.Double. Raw
// entities, always.
//
// USAGE
//   node bin/script/scripts/export-azure.js <output-dir> [flags]
//
//   --resume            reuse the newest run directory under <output-dir>
//   --run <id>          reuse/create a named run directory
//   --force             redo every step even if its output file exists
//   --skip-redis        skip the Redis metrics dump
//   --skip-blobs        skip the blob container inventories
//   --include-clients   also dump deploymentKeyClients:* field contents
//                       (one field PER DEVICE per deployment -- large, and not
//                        migrated; the sizes are always recorded)
//   --no-tls            connect to Redis without TLS (local instance only)
//
// Re-running the same command against the same run directory RESUMES: any step
// whose output file already exists is skipped, and package-history blobs are one
// file per deployment so an interrupted run picks up where it stopped. Partial
// writes go to `<name>.partial` and are renamed only on success, so a killed
// process can never leave a truncated file that a later run would trust.

import * as fs from "fs";
import * as path from "path";

import { AzureNamedKeyCredential, TableClient, TableEntityResult } from "@azure/data-tables";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

// Mirrors azure-storage.ts:161-163. The bundle/manifest/diff container shares
// its name with the table -- that is not a typo in this file, it is a quirk of
// the upstream code (AzureStorage.TABLE_NAME is passed to getContainerClient).
const TABLE_NAME = "storagev2";
const BLOB_CONTAINER_NAME = "storagev2";
const HISTORY_BLOB_CONTAINER_NAME = "packagehistoryv1";

// redis-manager.ts:92 -- metrics live in DB 1, the response cache in DB 0.
const METRICS_DB = 1;
const DEPLOYMENT_KEY_LABELS_PREFIX = "deploymentKeyLabels:";
const DEPLOYMENT_KEY_CLIENTS_PREFIX = "deploymentKeyClients:";

// The key grammar being decoded (azure-storage.ts:25-26).
const DELIMITER = " ";
const LEAF_MARKER = "*";
const ACCESS_KEY_MARKER = "_accessKeyId" + LEAF_MARKER + "_";

type EntityKind =
  | "account"
  | "account_pointer"
  | "app"
  | "app_pointer"
  | "deployment"
  | "access_key"
  | "access_key_pointer"
  | "deployment_key_pointer"
  | "health"
  | "unknown";

const ENTITY_KINDS: EntityKind[] = [
  "account",
  "account_pointer",
  "app",
  "app_pointer",
  "deployment",
  "access_key",
  "access_key_pointer",
  "deployment_key_pointer",
  "health",
  "unknown",
];

interface RawEntity {
  partitionKey: string;
  rowKey: string;
  [property: string]: unknown;
}

interface ClassifiedEntity {
  kind: EntityKind;
  // Ids decoded out of the key grammar. Present only where the grammar carries
  // them; the entity body is still the source of truth for everything else.
  accountId?: string;
  appId?: string;
  deploymentId?: string;
  accessKeyId?: string;
  accessKeyNameHash?: string;
  deploymentKey?: string;
  email?: string;
  entity: RawEntity;
}

interface BlobInventoryItem {
  name: string;
  size: number;
  content_type: string;
  last_modified: string;
  etag: string;
  md5_base64: string;
}

interface RedisClientLike {
  select(db: number, cb: (err: Error | null) => void): void;
  scan(cursor: string, ...args: (string | number | ((err: Error | null, reply: [string, string[]]) => void))[]): void;
  hgetall(key: string, cb: (err: Error | null, reply: Record<string, string> | null) => void): void;
  hlen(key: string, cb: (err: Error | null, reply: number) => void): void;
  dbsize(cb: (err: Error | null, reply: number) => void): void;
  quit(cb: (err: Error | null) => void): void;
  on(event: string, listener: (err: Error) => void): void;
}

interface Flags {
  outputRoot: string;
  runId: string | null;
  resume: boolean;
  force: boolean;
  skipRedis: boolean;
  skipBlobs: boolean;
  includeClients: boolean;
  noTls: boolean;
}

// ── argv ─────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  const flags: Flags = {
    outputRoot: "",
    runId: null,
    resume: false,
    force: false,
    skipRedis: false,
    skipBlobs: false,
    includeClients: false,
    noTls: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg: string = argv[i];
    switch (arg) {
      case "--resume":
        flags.resume = true;
        break;
      case "--run":
        flags.runId = argv[++i];
        break;
      case "--force":
        flags.force = true;
        break;
      case "--skip-redis":
        flags.skipRedis = true;
        break;
      case "--skip-blobs":
        flags.skipBlobs = true;
        break;
      case "--include-clients":
        flags.includeClients = true;
        break;
      case "--no-tls":
        flags.noTls = true;
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
    throw new Error("Usage: node bin/script/scripts/export-azure.js <output-dir> [--resume] [--run <id>] [--force]");
  }

  flags.outputRoot = path.resolve(positional[0]);
  return flags;
}

// ── env ──────────────────────────────────────────────────────────────────────

function loadDotEnv(): void {
  // dotenv is a devDependency, so a production install will not have it. The
  // script must still run when the variables come from the shell -- hence the
  // guarded require rather than a top-level import.
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

// ── io helpers ───────────────────────────────────────────────────────────────

function log(message: string): void {
  console.log(`[export-azure] ${message}`);
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Azure Tables hands back Edm.Int64 as a JS bigint, which JSON.stringify throws
// on outright ("Do not know how to serialize a BigInt") -- and `createdTime` /
// `expires` are exactly the properties that arrive that way on some rows. Dates
// are already ISO strings by the time a replacer sees them (Date.prototype.toJSON
// runs first); Uint8Array is not, and would serialize as {"0":12,"1":...}.
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    // Out of double range: keep the digits rather than silently corrupting them.
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return value;
}

function writeJsonFile(filePath: string, payload: unknown): void {
  const partial: string = `${filePath}.partial`;
  fs.writeFileSync(partial, JSON.stringify(payload, jsonReplacer, 2), "utf8");
  fs.renameSync(partial, filePath);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveRunDir(flags: Flags): string {
  ensureDir(flags.outputRoot);

  if (flags.runId) {
    return path.join(flags.outputRoot, flags.runId);
  }

  if (flags.resume) {
    const candidates: string[] = fs
      .readdirSync(flags.outputRoot)
      .filter((name: string) => name.indexOf("export-") === 0)
      .filter((name: string) => fs.statSync(path.join(flags.outputRoot, name)).isDirectory())
      .sort();
    if (candidates.length === 0) {
      throw new Error(`--resume given but no export-* run directory exists under ${flags.outputRoot}`);
    }
    return path.join(flags.outputRoot, candidates[candidates.length - 1]);
  }

  return path.join(flags.outputRoot, `export-${utcStamp()}`);
}

// ── key grammar ──────────────────────────────────────────────────────────────

// Decodes ONE table row back into the entity it represents. Every branch here
// is the inverse of a function in azure-storage.ts's `Keys` module; the ids are
// shortid values whose alphabet is forced to [0-9a-zA-Z_-] (:173), so they can
// contain '_' but never a space or a '*'. That is why the access-key row -- the
// one shape using '_' as its delimiter (:90-99) -- is split on the literal
// '_accessKeyId*_' marker and not on the first underscore.
function classify(entity: RawEntity): ClassifiedEntity {
  const pk: string = entity.partitionKey || "";
  const rk: string = entity.rowKey || "";

  if (pk === "health") {
    return { kind: "health", entity };
  }

  if (pk.indexOf("email" + DELIMITER) === 0) {
    // The ACCOUNT ITSELF lives in the email partition; every other account
    // address is a pointer to it (azure-storage.ts:214-236).
    return { kind: "account", email: pk.substring(("email" + DELIMITER).length), entity };
  }

  if (pk.indexOf("accessKey" + DELIMITER) === 0) {
    return { kind: "access_key_pointer", accessKeyNameHash: pk.substring(("accessKey" + DELIMITER).length), entity };
  }

  if (pk.indexOf("deploymentKey" + DELIMITER) === 0) {
    return { kind: "deployment_key_pointer", deploymentKey: pk.substring(("deploymentKey" + DELIMITER).length), entity };
  }

  if (pk.indexOf("accountId" + DELIMITER) === 0) {
    const accountId: string = pk.substring(("accountId" + DELIMITER).length);

    const markerIndex: number = rk.indexOf(ACCESS_KEY_MARKER);
    if (rk.indexOf("accountId_") === 0 && markerIndex >= 0) {
      return {
        kind: "access_key",
        accountId,
        accessKeyId: rk.substring(markerIndex + ACCESS_KEY_MARKER.length),
        entity,
      };
    }

    const appLeaf: string = DELIMITER + "appId" + LEAF_MARKER + DELIMITER;
    const appLeafIndex: number = rk.indexOf(appLeaf);
    if (appLeafIndex >= 0) {
      return { kind: "app_pointer", accountId, appId: rk.substring(appLeafIndex + appLeaf.length), entity };
    }

    if (rk.indexOf("accountId" + LEAF_MARKER + DELIMITER) === 0) {
      return { kind: "account_pointer", accountId, entity };
    }

    return { kind: "unknown", accountId, entity };
  }

  if (pk.indexOf("appId" + DELIMITER) === 0) {
    const appId: string = pk.substring(("appId" + DELIMITER).length);

    const deploymentLeaf: string = DELIMITER + "deploymentId" + LEAF_MARKER + DELIMITER;
    const deploymentLeafIndex: number = rk.indexOf(deploymentLeaf);
    if (deploymentLeafIndex >= 0) {
      return { kind: "deployment", appId, deploymentId: rk.substring(deploymentLeafIndex + deploymentLeaf.length), entity };
    }

    if (rk.indexOf("appId" + LEAF_MARKER + DELIMITER) === 0) {
      return { kind: "app", appId, entity };
    }

    return { kind: "unknown", appId, entity };
  }

  return { kind: "unknown", entity };
}

// ── step 1: the table ────────────────────────────────────────────────────────

async function dumpTable(runDir: string, tableClient: TableClient, force: boolean): Promise<string> {
  const jsonlPath: string = path.join(runDir, `table-${TABLE_NAME}.jsonl`);

  if (!force && fileExists(jsonlPath)) {
    log(`table dump already present, skipping (${jsonlPath})`);
    return jsonlPath;
  }

  const partial: string = `${jsonlPath}.partial`;
  const out: fs.WriteStream = fs.createWriteStream(partial, { encoding: "utf8" });
  let written = 0;

  for await (const entity of tableClient.listEntities<Record<string, unknown>>()) {
    const line: string = JSON.stringify(entity as TableEntityResult<Record<string, unknown>>, jsonReplacer) + "\n";
    if (!out.write(line)) {
      await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    written++;
    if (written % 1000 === 0) {
      log(`  ...${written} rows`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.once("error", reject);
  });
  fs.renameSync(partial, jsonlPath);
  log(`table ${TABLE_NAME}: ${written} rows -> ${path.basename(jsonlPath)}`);
  return jsonlPath;
}

function readTableDump(jsonlPath: string): RawEntity[] {
  const contents: string = fs.readFileSync(jsonlPath, "utf8");
  const entities: RawEntity[] = [];
  for (const line of contents.split("\n")) {
    const trimmed: string = line.trim();
    if (trimmed.length > 0) {
      entities.push(JSON.parse(trimmed) as RawEntity);
    }
  }
  return entities;
}

// ── step 2: split by row shape ───────────────────────────────────────────────

function writeClassifiedEntities(
  runDir: string,
  runId: string,
  entities: RawEntity[]
): { classified: ClassifiedEntity[]; counts: Record<string, number> } {
  const entitiesDir: string = path.join(runDir, "entities");
  ensureDir(entitiesDir);

  const classified: ClassifiedEntity[] = entities.map(classify);
  const counts: Record<string, number> = {};

  for (const kind of ENTITY_KINDS) {
    const items: ClassifiedEntity[] = classified.filter((candidate: ClassifiedEntity) => candidate.kind === kind);
    counts[kind] = items.length;
    writeJsonFile(path.join(entitiesDir, `${kind}.json`), {
      exported_at: new Date().toISOString(),
      run_id: runId,
      kind,
      count: items.length,
      items,
    });
  }

  return { classified, counts };
}

// ── step 3: package history blobs ────────────────────────────────────────────

async function dumpPackageHistory(
  runDir: string,
  blobService: BlobServiceClient,
  deploymentIds: string[],
  force: boolean
): Promise<{ fetched: number; missing: number; skipped: number }> {
  const historyDir: string = path.join(runDir, "package-history");
  ensureDir(historyDir);

  const container = blobService.getContainerClient(HISTORY_BLOB_CONTAINER_NAME);
  let fetched = 0;
  let missing = 0;
  let skipped = 0;

  for (const deploymentId of deploymentIds) {
    // The blob id IS the deployment id (azure-storage.ts:602, :1053). Ids come
    // from shortid's restricted alphabet so they are safe as filenames, but a
    // corrupted row must not be able to write outside the export directory.
    if (!/^[0-9a-zA-Z_-]+$/.test(deploymentId)) {
      throw new Error(`Refusing to write a history file for a deployment id with unexpected characters: '${deploymentId}'`);
    }

    const filePath: string = path.join(historyDir, `${deploymentId}.json`);
    if (!force && fileExists(filePath)) {
      skipped++;
      continue;
    }

    let packages: unknown[] = [];
    let blobMissing = false;
    try {
      const buffer: Buffer = await container.getBlobClient(deploymentId).downloadToBuffer();
      const parsed: unknown = JSON.parse(buffer.toString("utf8"));
      if (!Array.isArray(parsed)) {
        throw new Error(`History blob for ${deploymentId} is not a JSON array`);
      }
      packages = parsed;
      fetched++;
    } catch (error) {
      // A deployment created before its history blob was written, or one whose
      // blob was deleted by removeDeployment while the table row survived, is a
      // real state -- record it rather than aborting a multi-hour export.
      const code: string = (error && (error as { code?: string }).code) || "";
      if (code !== "BlobNotFound") {
        throw error;
      }
      blobMissing = true;
      missing++;
    }

    writeJsonFile(filePath, {
      exported_at: new Date().toISOString(),
      deployment_id: deploymentId,
      blob_container: HISTORY_BLOB_CONTAINER_NAME,
      blob_missing: blobMissing,
      count: packages.length,
      packages,
    });
  }

  return { fetched, missing, skipped };
}

// ── step 4: blob container inventories ───────────────────────────────────────

async function dumpBlobInventory(
  runDir: string,
  runId: string,
  blobService: BlobServiceClient,
  containerName: string,
  force: boolean
): Promise<{ count: number; totalBytes: number }> {
  const filePath: string = path.join(runDir, `blobs-${containerName}.json`);

  if (!force && fileExists(filePath)) {
    const existing = readJsonFile<{ count: number; total_bytes: number }>(filePath);
    log(`blob inventory for ${containerName} already present, skipping (${existing.count} objects)`);
    return { count: existing.count, totalBytes: existing.total_bytes };
  }

  const container = blobService.getContainerClient(containerName);
  const items: BlobInventoryItem[] = [];
  let totalBytes = 0;

  for await (const blob of container.listBlobsFlat()) {
    const size: number = blob.properties.contentLength || 0;
    totalBytes += size;
    items.push({
      name: blob.name,
      size,
      content_type: blob.properties.contentType || "",
      last_modified: blob.properties.lastModified ? blob.properties.lastModified.toISOString() : "",
      etag: blob.properties.etag || "",
      md5_base64: blob.properties.contentMD5 ? Buffer.from(blob.properties.contentMD5).toString("base64") : "",
    });
    if (items.length % 5000 === 0) {
      log(`  ...${items.length} objects in ${containerName}`);
    }
  }

  writeJsonFile(filePath, {
    exported_at: new Date().toISOString(),
    run_id: runId,
    container: containerName,
    count: items.length,
    total_bytes: totalBytes,
    items,
  });

  log(`blob inventory ${containerName}: ${items.length} objects, ${totalBytes} bytes`);
  return { count: items.length, totalBytes };
}

// ── step 5: Redis metrics ────────────────────────────────────────────────────

function connectRedis(noTls: boolean): RedisClientLike {
  // Same shape as redis-manager.ts:101-114 -- deliberately, so that "the export
  // connected" and "the server connects" are the same fact.
  const redis = require("redis");
  const config: Record<string, unknown> = {
    host: requireEnv("REDIS_HOST"),
    port: requireEnv("REDIS_PORT"),
    auth_pass: process.env.REDIS_KEY,
  };
  if (!noTls) {
    config.tls = { rejectUnauthorized: true };
  }

  const client: RedisClientLike = redis.createClient(config);
  client.on("error", (error: Error) => {
    console.error("[export-azure] redis error:", error);
  });
  return client;
}

function redisSelect(client: RedisClientLike, db: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.select(db, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}

function redisDbSize(client: RedisClientLike): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    client.dbsize((error: Error | null, reply: number) => (error ? reject(error) : resolve(reply)));
  });
}

function redisHGetAll(client: RedisClientLike, key: string): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    client.hgetall(key, (error: Error | null, reply: Record<string, string> | null) =>
      error ? reject(error) : resolve(reply || {})
    );
  });
}

function redisHLen(client: RedisClientLike, key: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    client.hlen(key, (error: Error | null, reply: number) => (error ? reject(error) : resolve(reply)));
  });
}

function redisQuit(client: RedisClientLike): Promise<void> {
  return new Promise<void>((resolve) => {
    client.quit(() => resolve());
  });
}

// SCAN, never KEYS: KEYS blocks the instance the live fleet is reporting into.
function redisScanAll(client: RedisClientLike): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const found: string[] = [];
    const step = (cursor: string): void => {
      client.scan(cursor, "COUNT", 500, (error: Error | null, reply: [string, string[]]) => {
        if (error) {
          reject(error);
          return;
        }
        const nextCursor: string = reply[0];
        found.push(...reply[1]);
        if (nextCursor === "0") {
          resolve(found);
        } else {
          step(nextCursor);
        }
      });
    };
    step("0");
  });
}

async function dumpRedisMetrics(
  runDir: string,
  runId: string,
  knownDeploymentKeys: string[],
  flags: Flags
): Promise<{ hashes: number; fields: number }> {
  const filePath: string = path.join(runDir, "redis-metrics.json");

  if (!flags.force && fileExists(filePath)) {
    const existing = readJsonFile<{ hash_count: number; field_count: number }>(filePath);
    log(`redis metrics already present, skipping (${existing.hash_count} hashes)`);
    return { hashes: existing.hash_count, fields: existing.field_count };
  }

  const client: RedisClientLike = connectRedis(flags.noTls);

  try {
    // DB 0 is the update-check response cache. Deliberately NOT migrated (it
    // rebuilds itself in an hour); its size is recorded only so the run has a
    // note of what was there.
    await redisSelect(client, 0);
    const cacheDbSize: number = await redisDbSize(client);

    await redisSelect(client, METRICS_DB);
    const metricsDbSize: number = await redisDbSize(client);
    const keys: string[] = await redisScanAll(client);

    const metricKeys: string[] = keys.filter((key: string) => key.indexOf(DEPLOYMENT_KEY_LABELS_PREFIX) === 0);
    const clientKeys: string[] = keys.filter((key: string) => key.indexOf(DEPLOYMENT_KEY_CLIENTS_PREFIX) === 0);
    const otherKeys: string[] = keys.filter(
      (key: string) => metricKeys.indexOf(key) < 0 && clientKeys.indexOf(key) < 0
    );

    // Scan first (catches metrics for deployments whose table row is gone), then
    // add an explicit read for every key the table knows about, so a deployment
    // with genuinely no metrics is recorded as an empty hash instead of being
    // indistinguishable from one this script failed to read.
    const wanted: string[] = metricKeys.slice();
    for (const deploymentKey of knownDeploymentKeys) {
      const hashKey: string = DEPLOYMENT_KEY_LABELS_PREFIX + deploymentKey;
      if (wanted.indexOf(hashKey) < 0) {
        wanted.push(hashKey);
      }
    }

    const hashes: Record<string, Record<string, number>> = {};
    let fieldCount = 0;
    for (const hashKey of wanted) {
      const deploymentKey: string = hashKey.substring(DEPLOYMENT_KEY_LABELS_PREFIX.length);
      const raw: Record<string, string> = await redisHGetAll(client, hashKey);
      const parsed: Record<string, number> = {};
      for (const field of Object.keys(raw)) {
        // Redis returns every value as a string; the counters are integers and
        // CAN be negative (recordUpdate decrements the previous label).
        const value: number = parseInt(raw[field], 10);
        if (isNaN(value)) {
          throw new Error(`Non-numeric metric value at ${hashKey} field '${field}': '${raw[field]}'`);
        }
        parsed[field] = value;
        fieldCount++;
      }
      hashes[deploymentKey] = parsed;
    }

    const clientHashSizes: Record<string, number> = {};
    const clients: Record<string, Record<string, string>> = {};
    for (const clientKey of clientKeys) {
      const deploymentKey: string = clientKey.substring(DEPLOYMENT_KEY_CLIENTS_PREFIX.length);
      clientHashSizes[deploymentKey] = await redisHLen(client, clientKey);
      if (flags.includeClients) {
        clients[deploymentKey] = await redisHGetAll(client, clientKey);
      }
    }

    const orphanKeys: string[] = Object.keys(hashes).filter(
      (deploymentKey: string) => knownDeploymentKeys.indexOf(deploymentKey) < 0 && Object.keys(hashes[deploymentKey]).length > 0
    );

    writeJsonFile(filePath, {
      exported_at: new Date().toISOString(),
      run_id: runId,
      host: process.env.REDIS_HOST,
      metrics_db: METRICS_DB,
      metrics_db_size: metricsDbSize,
      response_cache_db_size: cacheDbSize,
      hash_count: Object.keys(hashes).length,
      field_count: fieldCount,
      // deploymentKey -> { "v7:Active": 12, "v7:DeploymentSucceeded": 12, ... }
      hashes,
      // deploymentKeyClients:* is per-device state that is NOT migrated (the
      // replacement RedisManager keeps those methods as no-ops). Sizes are kept
      // because "how many devices were on this key" is otherwise unanswerable.
      client_hash_sizes: clientHashSizes,
      clients_included: flags.includeClients,
      clients,
      orphan_deployment_keys: orphanKeys,
      other_keys: otherKeys,
    });

    log(
      `redis DB ${METRICS_DB}: ${Object.keys(hashes).length} metric hashes, ${fieldCount} fields, ` +
        `${clientKeys.length} client hashes${orphanKeys.length ? `, ${orphanKeys.length} ORPHAN keys` : ""}`
    );
    return { hashes: Object.keys(hashes).length, fields: fieldCount };
  } finally {
    await redisQuit(client);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags: Flags = parseFlags(process.argv.slice(2));
  loadDotEnv();

  const accountName: string = requireEnv("AZURE_STORAGE_ACCOUNT");
  const accountKey: string = requireEnv("AZURE_STORAGE_ACCESS_KEY");

  const runDir: string = resolveRunDir(flags);
  const runId: string = path.basename(runDir);
  ensureDir(runDir);
  log(`run ${runId} -> ${runDir}`);

  const startedAt: string = new Date().toISOString();

  // Direct clients, NOT `new AzureStorage(...)`: its constructor creates the
  // table, both containers and three health entities. An export must be inert.
  const tableClient: TableClient = new TableClient(
    `https://${accountName}.table.core.windows.net`,
    TABLE_NAME,
    new AzureNamedKeyCredential(accountName, accountKey)
  );
  const blobService: BlobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new StorageSharedKeyCredential(accountName, accountKey)
  );

  const jsonlPath: string = await dumpTable(runDir, tableClient, flags.force);
  const entities: RawEntity[] = readTableDump(jsonlPath);
  const { classified, counts } = writeClassifiedEntities(runDir, runId, entities);
  log(`rows by shape: ${ENTITY_KINDS.map((kind: EntityKind) => `${kind}=${counts[kind]}`).join(" ")}`);

  const deploymentIds: string[] = classified
    .filter((item: ClassifiedEntity) => item.kind === "deployment")
    .map((item: ClassifiedEntity) => item.deploymentId)
    .filter((id: string) => !!id);

  const deploymentKeys: string[] = classified
    .filter((item: ClassifiedEntity) => item.kind === "deployment")
    .map((item: ClassifiedEntity) => String(item.entity.key || ""))
    .filter((key: string) => key.length > 0);

  const history = await dumpPackageHistory(runDir, blobService, deploymentIds, flags.force);
  log(`package history: ${history.fetched} fetched, ${history.skipped} already present, ${history.missing} blob(s) missing`);

  let bundleBlobs = { count: 0, totalBytes: 0 };
  let historyBlobs = { count: 0, totalBytes: 0 };
  if (flags.skipBlobs) {
    log("blob inventories skipped (--skip-blobs)");
  } else {
    bundleBlobs = await dumpBlobInventory(runDir, runId, blobService, BLOB_CONTAINER_NAME, flags.force);
    historyBlobs = await dumpBlobInventory(runDir, runId, blobService, HISTORY_BLOB_CONTAINER_NAME, flags.force);
  }

  let redis = { hashes: 0, fields: 0 };
  if (flags.skipRedis) {
    log("redis metrics skipped (--skip-redis) -- REMEMBER: this is the only copy");
  } else {
    redis = await dumpRedisMetrics(runDir, runId, deploymentKeys, flags);
  }

  const finishedAt: string = new Date().toISOString();
  const summary: Record<string, number> = {
    table_rows: entities.length,
    package_history_files: history.fetched + history.skipped,
    package_history_missing: history.missing,
    blob_objects: bundleBlobs.count,
    blob_bytes: bundleBlobs.totalBytes,
    history_blob_objects: historyBlobs.count,
    redis_metric_hashes: redis.hashes,
    redis_metric_fields: redis.fields,
  };
  for (const kind of ENTITY_KINDS) {
    summary[`row_${kind}`] = counts[kind];
  }

  writeJsonFile(path.join(runDir, "manifest.json"), {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    complete: !flags.skipRedis && !flags.skipBlobs,
    source: {
      azure_storage_account: accountName,
      table: TABLE_NAME,
      blob_containers: [BLOB_CONTAINER_NAME, HISTORY_BLOB_CONTAINER_NAME],
      redis_host: flags.skipRedis ? null : process.env.REDIS_HOST || null,
      redis_metrics_db: METRICS_DB,
    },
    flags: {
      force: flags.force,
      skip_redis: flags.skipRedis,
      skip_blobs: flags.skipBlobs,
      include_clients: flags.includeClients,
    },
    counts: summary,
  });

  writeJsonFile(path.join(flags.outputRoot, "latest.json"), {
    run_id: runId,
    run_dir: runDir,
    finished_at: finishedAt,
    complete: !flags.skipRedis && !flags.skipBlobs,
  });

  log("---- summary ----");
  for (const key of Object.keys(summary)) {
    log(`  ${key.padEnd(28)} ${summary[key]}`);
  }
  log(`done -> ${runDir}`);
}

main().catch((error: Error) => {
  console.error("[export-azure] FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
