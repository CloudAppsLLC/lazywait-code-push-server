// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//
// Supabase (Postgres + Supabase Storage) implementation of the `Storage` interface.
//
// WHY THIS FILE EXISTS
// --------------------
// `azure-storage.ts` is the only reason this service must live in Azure: its
// entire data layer is ONE Azure Table (`storagev2`) holding NINE different row
// shapes keyed by a hand-rolled "PartitionKey RowKey" grammar, plus two blob
// containers. This file replaces that with the Postgres schema authored in
// LazyWaitInternalAPI `supabase/migrations/803_codepush_core.sql` and one
// dedicated public bucket.
//
// WHAT IS DELIBERATELY *NOT* PORTED
//   * The PartitionKey/RowKey hierarchy, the `*` LEAF_MARKER, the two key
//     encodings (space-delimited for apps/deployments, underscore for access
//     keys) and the `RowKey gt X and RowKey lt X||'~'` prefix scans. Every one
//     of those rows was a hand-built secondary index; Postgres has real ones.
//     Only the `text` ids survive, verbatim, so the data migrates 1:1.
//   * ETags / If-Match. `AzureStorage.unwrap` destructured `etag` away, so
//     optimistic concurrency has never actually been possible here. The commit
//     RPC's row lock and the unique indexes are the whole concurrency story now.
//   * The package-history blob. History is rows in `codepush_package`.
//
// TWO DELIBERATE BEHAVIOUR DIVERGENCES FROM AzureStorage (both are FIXES, both
// are documented in 803's header -- read them before "fixing" a red test):
//   (a) clearPackageHistory really clears. Azure's `updateEntity` defaults to
//       Merge mode, which cannot remove a property, so `deployment.package`
//       SURVIVED a history clear there and the ERP page kept showing a ghost
//       release. Here `.package` is derived from the top-`seq` row, so deleting
//       the rows removes it -- which is what `json-storage.ts:579` always did.
//   (b) Labels do NOT restart at v1 after a clear. `label_counter` is monotonic
//       in the schema. Azure and JsonStorage both reissued `v1` for different
//       bytes, which a device's cached label then pointed at. A conformance
//       harness must compare label ORDERING after a clear, not label TEXT.
//
// THE ID-CHAIN RULE (non-negotiable)
// ----------------------------------
// `storage.ts:123` states the contract: "The Storage implementation should
// verify that the whole specified id chain is correct, not just the leaf id."
// Azure enforced it structurally -- a deployment of another app simply was not
// in the `appId <appId>` partition. A bare primary key loses that, so EVERY
// query in this file filters on the PAIR (`app_id` + `id`, `account_id` + `id`).
// A lone `.eq("id", deploymentId)` here is a cross-tenant IDOR: the owner of app
// A could read, patch, release into or DELETE a deployment of app B. Migration
// 803 ships redundant `UNIQUE (app_id, id)` / `UNIQUE (account_id, id)`
// constraints purely to make the correct query cheap and the wrong one obvious
// in review.
//

import * as q from "q";
import * as shortid from "shortid";
import * as stream from "stream";
import * as storage from "./storage";
import * as errorModule from "../error";
import * as utils from "../utils/common";

// PINNED to ~2.45.x on purpose. From ~2.90 onward `createClient`/`SupabaseClient`
// carry a chain of conditional generic DEFAULTS that this repo's TS 5.0 config
// cannot resolve against an untyped schema -- it fails the build outright with
// "TS2589: Type instantiation is excessively deep and possibly infinite" on the
// constructor call, not on anything we wrote. Nothing used here postdates 2.34
// (the embedded-resource `referencedTable` option), so the pin costs nothing.
import { SupabaseClient, SupabaseClientOptions } from "@supabase/supabase-js";

// ── configuration ─────────────────────────────────────────────────────────────
//
// The PostgREST client is pointed at the project with the `codepush_api` JWT,
// NOT the service-role key. 803's header explains why: handing a 12-year-old
// fork carrying a 100 MB multer buffer the service-role key would give it
// `pos_orders`, `hrms_employees` and `platform_support_access_log` -- a strictly
// larger blast radius than the Azure storage-account key it replaces. The JWT is
// signed with the project JWT secret and carries {"role":"codepush_api"}; 803
// grants that role exactly the nine codepush tables and the two RPCs.
//
// Exported under their long names as well: the Postgres metrics backend
// (supabase-metrics-manager.ts) talks to the SAME project with the SAME
// credentials, and two copies of a variable name is how a rename ends up half
// applied.
export const ENV_SUPABASE_URL = "SUPABASE_URL";
export const ENV_CODEPUSH_JWT = "SUPABASE_CODEPUSH_JWT";

const ENV_URL = ENV_SUPABASE_URL;
const ENV_JWT = ENV_CODEPUSH_JWT;
const ENV_STORAGE_KEY = "SUPABASE_CODEPUSH_STORAGE_KEY";
const ENV_BUCKET = "SUPABASE_CODEPUSH_BUCKET";
const ENV_PUBLIC_URL = "SUPABASE_CODEPUSH_PUBLIC_URL";

/**
 * The project's ANON key, used ONLY as the `apikey` gateway header.
 *
 * TWO HEADERS, TWO DIFFERENT CREDENTIALS -- and conflating them is a 401 on
 * every single request. Supabase Cloud fronts PostgREST and Storage with a
 * gateway that authenticates `apikey` against the project's OWN issued keys
 * (anon / service_role). A self-signed `codepush_api` JWT is not one of those,
 * so sending it as `apikey` is rejected before PostgREST is ever reached, with
 * `{"message":"Invalid API key","hint":"Double check your Supabase anon or
 * service_role API key."}` -- a message that points at the wrong credential
 * entirely and says nothing about the role or the signature.
 *
 * `new SupabaseClient(url, key)` sets BOTH `apikey: key` and
 * `Authorization: Bearer key`, so passing the codepush_api JWT there poisons the
 * gateway header. The correct shape is: `apikey` = anon key (identifies the
 * PROJECT), `Authorization` = the codepush_api JWT (identifies the ROLE). The
 * anon key grants nothing on its own here -- 803 REVOKEs anon from every
 * codepush_* table -- so this is not a widening of access; it is the routing
 * credential the platform requires.
 */
const ENV_ANON_KEY = "SUPABASE_CODEPUSH_APIKEY";
const ENV_ANON_KEY_FALLBACK = "SUPABASE_ANON_KEY";

// SUPERSEDES the migration design's "shared LazyWaitStorage bucket under a
// codepush/ prefix". A DEDICATED bucket, because: LazyWaitStorage's
// `file_size_limit` is a per-bucket setting shared with every tenant upload path
// (raising it for 30 MB bundles raises it for every cashier); the documented
// invariant for that bucket is that its root holds only `partner/` and
// `retail_db/`; and a dedicated bucket does not depend on the drifted policy
// state of migrations 024/601.
const DEFAULT_BUCKET = "LazyWaitCodePush";

// ONE flat prefix. `addBlob(blobId, stream, length)` (storage.ts:162) carries no
// category argument, so nothing at the call site knows whether a blobId is a
// bundle, a manifest or a diff. Three prefixes would force `getBlobUrl` into a
// `codepush_blob` round trip and break the "deterministic from the key" property
// the acquisition path depends on.
const BLOB_PREFIX = "blobs";

// Matches AzureStorage.MAX_PACKAGE_HISTORY_LENGTH. The trim itself happens
// inside the commit RPC (by ROW COUNT, not by seq arithmetic -- seq is not dense
// after an import or a history clear).
const MAX_PACKAGE_HISTORY_LENGTH = 50;

const TABLE_ACCOUNT = "codepush_account";
const TABLE_APP = "codepush_app";
const TABLE_COLLABORATOR = "codepush_app_collaborator";
const TABLE_DEPLOYMENT = "codepush_deployment";
const TABLE_PACKAGE = "codepush_package";
const TABLE_PACKAGE_DIFF_BLOB = "codepush_package_diff_blob";
const TABLE_ACCESS_KEY = "codepush_access_key";
const TABLE_BLOB = "codepush_blob";

const RPC_COMMIT_PACKAGE = "codepush_commit_package";

// Explicit column lists rather than `*`: a column added to the table later must
// not silently change the payload size of the acquisition hot path.
//
// The `: string` annotations are deliberate. `@supabase/supabase-js` parses the
// select string IN THE TYPE SYSTEM to synthesise a result type; against an
// untyped schema that buys nothing here (we cast to the row interfaces above
// either way) and it costs a `TS2589: Type instantiation is excessively deep`
// on a 21-column embedded select. Widening these to `string` makes the parser
// bow out cleanly, which is why every read below goes through asRow/asRows.
const ACCOUNT_COLUMNS: string = "id,email,name,github_id,microsoft_id,azure_ad_id,created_at";
const APP_COLUMNS: string = "id,name,created_at";
const COLLABORATOR_COLUMNS: string = "app_id,account_id,email,permission";
const DEPLOYMENT_COLUMNS: string = "id,app_id,name,deployment_key,created_at";
const PACKAGE_COLUMNS: string =
  "id,deployment_id,label,seq,app_version,description,package_hash,blob_id,blob_url," +
  "manifest_blob_id,manifest_blob_url,diff_package_map,is_disabled,is_mandatory,rollout," +
  "size_bytes,release_method,original_deployment,original_label,released_by,uploaded_at";
const ACCESS_KEY_COLUMNS: string = "id,account_id,name_hash,friendly_name,description,created_by,is_session,created_at,expires_at";

// ── row shapes (what PostgREST hands back) ────────────────────────────────────

interface AccountRow {
  id: string;
  email: string;
  name: string;
  github_id: string | null;
  microsoft_id: string | null;
  azure_ad_id: string | null;
  created_at: string;
}

interface AppRow {
  id: string;
  name: string;
  created_at: string;
}

interface CollaboratorRow {
  app_id: string;
  account_id: string;
  email: string;
  permission: string;
}

interface DeploymentRow {
  id: string;
  app_id: string;
  name: string;
  deployment_key: string;
  created_at: string;
}

interface PackageRow {
  id: number;
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
  diff_package_map: storage.PackageHashToBlobInfoMap | null;
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

interface AccessKeyRow {
  id: string;
  account_id: string;
  name_hash: string;
  friendly_name: string;
  description: string | null;
  created_by: string | null;
  is_session: boolean;
  created_at: string;
  expires_at: string;
}

// A deployment row with the single newest package embedded (PostgREST's
// per-parent `limit` on an embedded resource -- "top N per group").
interface DeploymentRowWithPackage extends DeploymentRow {
  codepush_package?: PackageRow[];
}

// The shape supabase-js/PostgREST reports failures in. Never `any`: `code` is a
// SQLSTATE string ("23505") or a PostgREST code ("PGRST116"), never a number --
// which is exactly what lets the numeric passthrough below work.
interface PostgrestFailure {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

// A supabase-js StorageApiError carries an HTTP status instead of a SQLSTATE.
interface StorageApiFailure {
  status?: number;
  statusCode?: string;
  error?: string;
  message?: string;
  name?: string;
  code?: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Reinterpret a PostgREST payload as one of the row interfaces above.
 *
 * supabase-js types `data` from the select string, and this client is pointed at
 * an untyped schema, so the compiler's view of it is a placeholder. The row
 * interfaces in this file are the real contract -- they are kept in lockstep
 * with migration 803 by hand, and the conformance harness is what proves it.
 */
function asRow<T>(data: unknown): T {
  return (data || null) as T;
}

function asRows<T>(data: unknown): T[] {
  return (data || []) as T[];
}

function nowMs(): number {
  return new Date().getTime();
}

function toEpochMs(timestamptz: string): number {
  const parsed: number = Date.parse(timestamptz);
  return isNaN(parsed) ? 0 : parsed;
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Escape a value that is about to be used as an ILIKE *literal*.
 *
 * WHY: emails legally contain `_`, which is a single-character wildcard in SQL
 * LIKE. Unescaped, `a_b@x.com` would also match `aXb@x.com` -- i.e. one account
 * could be resolved by another account's address. Backslash is LIKE's default
 * escape character, so `\_` is a literal underscore.
 *
 * `*` is left alone deliberately: PostgREST rewrites `*` to `%` before Postgres
 * ever sees the pattern, so it cannot be escaped from here -- and `*` is not a
 * legal character in an email address, which is the only thing this is used for.
 */
function escapeIlikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * True when the object is a StorageError this module (or storage.ts) already
 * produced.
 *
 * WHY THIS MATTERS: mirrors `azure-storage.ts:1434-1437`. Without the
 * passthrough, `getAccountIdFromAccessKey`'s deliberate `ErrorCode.Expired`
 * would be swallowed by the generic mapper and every expired CLI token would
 * read as an HTTP 500 instead of the 401 the auth strategy expects.
 */
function isStorageError(candidate: unknown): candidate is storage.StorageError {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const maybe = candidate as { source?: errorModule.ErrorSource; code?: unknown };
  return maybe.source === errorModule.ErrorSource.Storage && typeof maybe.code === "number";
}

function isConnectionFailure(failure: PostgrestFailure & StorageApiFailure): boolean {
  // supabase-js surfaces a dead socket / DNS failure as an undici TypeError with
  // no SQLSTATE at all, so the message is genuinely the only signal available.
  const code: string = String(failure.code || "");
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "ABORT_ERR"
  ) {
    return true;
  }

  const message: string = String(failure.message || "").toLowerCase();
  return (
    message.indexOf("fetch failed") !== -1 ||
    message.indexOf("network") !== -1 ||
    message.indexOf("socket hang up") !== -1 ||
    message.indexOf("econnrefused") !== -1 ||
    message.indexOf("timeout") !== -1
  );
}

/**
 * 23505 -> AlreadyExists, mapped PER INDEX.
 *
 * WHY PER INDEX: session access keys are minted as
 * `friendlyName = "Login-" + Date.now()` with no duplicate check
 * (`passport-authentication.ts:322-333`). Two logins in the same millisecond now
 * collide on `codepush_access_key_account_friendly_uidx`. That has to become the
 * route's intended 409, not an opaque 500 on a login.
 */
function messageForUniqueViolation(failure: PostgrestFailure): string {
  const haystack: string = `${failure.message || ""} ${failure.details || ""} ${failure.hint || ""}`;

  if (haystack.indexOf("codepush_access_key_account_friendly_uidx") !== -1) {
    return "An access key with that name already exists.";
  }
  if (haystack.indexOf("codepush_access_key_name_hash_uidx") !== -1) {
    return "That access key already exists.";
  }
  if (haystack.indexOf("codepush_account_email_lower_uidx") !== -1) {
    return "An account with that email address already exists.";
  }
  if (haystack.indexOf("codepush_app_collaborator_owner_name_uidx") !== -1) {
    return "An app with that name already exists for that account.";
  }
  if (haystack.indexOf("codepush_app_collaborator_app_email_uidx") !== -1) {
    return "The given account is already a collaborator for this app.";
  }
  if (haystack.indexOf("codepush_deployment_key_uidx") !== -1) {
    return "That deployment key is already in use.";
  }
  if (haystack.indexOf("codepush_deployment_app_name_uidx") !== -1) {
    return "A deployment with that name already exists for this app.";
  }
  if (
    haystack.indexOf("codepush_package_deployment_label_uidx") !== -1 ||
    haystack.indexOf("codepush_package_deployment_seq_uidx") !== -1
  ) {
    return "A release with that label already exists on this deployment.";
  }

  return failure.message || "The provided resource already exists";
}

/**
 * The single error mapper. Mirrors `azure-storage.ts:1412-1468`.
 *
 * Exported because the Postgres metrics backend hits the same project through
 * the same PostgREST endpoint: a 42P01 ("migration 803 is not applied here") or
 * a dead socket must produce the identical StorageError whichever of the two
 * touches it first, and a second copy of this switch would drift.
 */
export function toStorageError(rawError: unknown, fallbackMessage?: string): storage.StorageError {
  // Numeric passthrough FIRST -- see isStorageError().
  if (isStorageError(rawError)) {
    return rawError;
  }

  const failure = (rawError || {}) as PostgrestFailure & StorageApiFailure;
  const code: string = String(failure.code || "");

  if (isConnectionFailure(failure)) {
    return storage.storageError(storage.ErrorCode.ConnectionFailed, failure.message || fallbackMessage);
  }

  switch (code) {
    case "23505": // unique_violation
      return storage.storageError(storage.ErrorCode.AlreadyExists, messageForUniqueViolation(failure));
    case "23503": // foreign_key_violation -- the parent in the id chain is gone
      return storage.storageError(storage.ErrorCode.NotFound, fallbackMessage || failure.message);
    case "23502": // not_null_violation
    case "23514": // check_violation
    case "22P02": // invalid_text_representation
    case "22001": // string_data_right_truncation
      return storage.storageError(storage.ErrorCode.Invalid, failure.message || fallbackMessage);
    case "P0002": // plpgsql no_data_found -- raised by codepush_commit_package
    case "PGRST116": // .single()/.maybeSingle() found no row
      return storage.storageError(storage.ErrorCode.NotFound, fallbackMessage || failure.message);
    case "42501": // insufficient_privilege -- codepush_api is missing a GRANT/policy
    case "42P01": // undefined_table -- migration 803 is not applied here
    case "42883": // undefined_function -- ditto, for the RPCs
      return storage.storageError(
        storage.ErrorCode.Other,
        `CodePush schema is not usable by this role (${code}): ${failure.message || ""}`
      );
    default:
      break;
  }

  // Supabase Storage (the bucket API) answers with HTTP status codes, not
  // SQLSTATEs.
  const httpStatus: number = Number(failure.status || failure.statusCode || 0);
  if (httpStatus === 404) {
    return storage.storageError(storage.ErrorCode.NotFound, failure.message || fallbackMessage);
  }
  if (httpStatus === 409) {
    return storage.storageError(storage.ErrorCode.AlreadyExists, failure.message || fallbackMessage);
  }
  if (httpStatus === 413) {
    return storage.storageError(storage.ErrorCode.TooLarge, failure.message || fallbackMessage);
  }

  return storage.storageError(storage.ErrorCode.Other, failure.message || fallbackMessage);
}

function rejectStorage(errorCode: storage.ErrorCode, message?: string): never {
  throw storage.storageError(errorCode, message);
}

export class SupabaseStorage implements storage.Storage {
  private _client: SupabaseClient;
  private _objectClient: SupabaseClient;
  private _bucket: string;
  private _publicBaseUrl: string;
  private _blobUrlPrefix: string;

  public constructor(url?: string, jwt?: string, storageKey?: string) {
    // Same alphabet restriction AzureStorage applied (azure-storage.ts:173). Ids
    // are compared, embedded in URLs and used as storage object names, so the
    // charset has to stay [0-9a-zA-Z_-] for the data to migrate verbatim.
    shortid.characters("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-");

    const resolvedUrl: string = url || process.env[ENV_URL];
    const resolvedJwt: string = jwt || process.env[ENV_JWT];

    if (!resolvedUrl || !resolvedJwt) {
      // Fail at BOOT, loudly, exactly as AzureStorage does for missing Azure
      // credentials. A per-request 500 with no cause is far worse to diagnose.
      throw new Error(`Supabase credentials not set: ${ENV_URL} and ${ENV_JWT} are both required.`);
    }

    this._bucket = process.env[ENV_BUCKET] || DEFAULT_BUCKET;
    this._publicBaseUrl = (process.env[ENV_PUBLIC_URL] || resolvedUrl).replace(/\/+$/, "");
    this._blobUrlPrefix = `${this._publicBaseUrl}/storage/v1/object/public/${this._bucket}/${BLOB_PREFIX}/`;

    // See ENV_ANON_KEY: `apikey` identifies the PROJECT to the gateway and must
    // be one of the project's own issued keys; `Authorization` identifies the
    // ROLE. Passing the codepush_api JWT as the client key sets both, and the
    // gateway then 401s every request with "Invalid API key" before PostgREST
    // sees it. So: anon key as the client key, codepush_api JWT forced on via
    // global headers (supabase-js merges these OVER its own defaults).
    const resolvedApiKey: string =
      process.env[ENV_ANON_KEY] || process.env[ENV_ANON_KEY_FALLBACK] || "";

    if (!resolvedApiKey) {
      throw new Error(
        `Supabase credentials not set: ${ENV_ANON_KEY} (or ${ENV_ANON_KEY_FALLBACK}) is required. ` +
          `It is the project's anon key and is sent ONLY as the 'apikey' gateway header; ` +
          `${ENV_JWT} remains the credential that carries the codepush_api role.`
      );
    }

    const clientOptions: SupabaseClientOptions<"public"> = {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: {
          "x-client-info": "lazywait-codepush-server",
          Authorization: `Bearer ${resolvedJwt}`,
        },
      },
    };

    this._client = new SupabaseClient(resolvedUrl, resolvedApiKey, clientOptions);

    // ONE CREDENTIAL IS THE INTENDED CONFIGURATION, and the fall-through below is
    // therefore NOT a warning.
    //
    // The bucket is public-read / privileged-write, so an upload has to satisfy
    // `storage.objects` INSERT -- and the codepush_api JWT does, on its own.
    //
    // MEASURED on a hosted project (dev, 2026-09-07): POST and GET of
    // /storage/v1/object/LazyWaitCodePush/blobs/... both return 200 with this
    // token, while the same POST with the anon key is refused. Note this holds
    // EVEN THOUGH 803's storage-schema GRANTs raise 42501 on Supabase Cloud
    // (`supabase_storage_admin` is a reserved role) -- storage-api does not
    // appear to SET ROLE the way PostgREST does, so the grants are not what
    // makes it work. An earlier revision of this comment asserted the grants
    // were load-bearing; they are not, and the file that said so has been
    // corrected too.
    //
    // The consequence is the good one: ONE credential covers both legs, and the
    // service-role key never enters this container's environment. 803's header
    // says why that matters -- it would hand a fork that buffers large uploads
    // in memory `pos_orders`, `hrms_employees` and `platform_support_access_log`.
    //
    // SUPABASE_CODEPUSH_STORAGE_KEY therefore stays an ESCAPE HATCH, not a
    // requirement -- for a project where 803's storage half was not applied, or
    // where someone wants bucket writes on a separately-rotated credential. An
    // earlier revision of this file warned at every boot that 803 "does not
    // create one"; that was wrong against the migration as authored, and it sent
    // operators looking for a second key the correct deployment does not need.
    const resolvedStorageKey: string = storageKey || process.env[ENV_STORAGE_KEY] || resolvedJwt;
    this._objectClient =
      resolvedStorageKey === resolvedJwt
        ? this._client
        : new SupabaseClient(resolvedUrl, resolvedApiKey, {
            ...clientOptions,
            // A DIFFERENT credential, so it needs its own Authorization -- reusing
            // clientOptions verbatim would silently keep the codepush_api JWT and
            // make SUPABASE_CODEPUSH_STORAGE_KEY a no-op, i.e. the escape hatch
            // would appear configured while changing nothing.
            //
            // `apikey` stays the anon key in BOTH clients: it is the gateway's
            // project router, not an authorisation. When the storage key is a
            // service-role JWT this is still correct -- service_role's power comes
            // from its own claims in the bearer, not from the apikey slot.
            global: {
              headers: {
                "x-client-info": "lazywait-codepush-server",
                Authorization: `Bearer ${resolvedStorageKey}`,
              },
            },
          });

    if (resolvedStorageKey !== resolvedJwt) {
      // Worth ONE line at boot, because it is the unusual shape: two credentials
      // means a 403 at addBlob() has two possible causes, and the operator should
      // know which one this process is using before they go looking.
      console.log(
        `[supabase-storage] ${ENV_STORAGE_KEY} is set; bucket writes to '${this._bucket}' use it instead of ${ENV_JWT}. ` +
          `The default (unset) is correct on a project where migration 803 was applied in full.`
      );
    }
  }

  // ── health ──────────────────────────────────────────────────────────────────

  public checkHealth(): q.Promise<void> {
    return q(this.checkHealthAsync());
  }

  private async checkHealthAsync(): Promise<void> {
    // A REAL round trip, and the cheapest one that proves everything that can
    // actually be broken here: the project URL resolves, the JWT is valid, the
    // `codepush_api` role has its GRANT, the deny-all RLS policy is not also
    // denying us, and migration 803 is applied. A `head` count reads no rows, so
    // an empty database is still healthy.
    //
    // Deliberately NOT probed: the bucket. A bucket LIST is not the operation
    // the fleet performs -- devices do an anonymous public GET, which no
    // credential this process holds can meaningfully rehearse. That check is an
    // external curl in the cutover runbook, and wiring it in here would make
    // /health fail closed on a permission the download path does not use.
    const { error } = await this._client.from(TABLE_ACCOUNT).select("id", { head: true }).limit(1);

    if (error) {
      throw toStorageError(error, "The CodePush Postgres schema failed the health check");
    }
  }

  // ── accounts ────────────────────────────────────────────────────────────────

  public addAccount(account: storage.Account): q.Promise<string> {
    return q(this.addAccountAsync(account));
  }

  private async addAccountAsync(account: storage.Account): Promise<string> {
    const toInsert: storage.Account = storage.clone(account); // pass by value
    toInsert.id = shortid.generate();

    const { error } = await this._client.from(TABLE_ACCOUNT).insert({
      id: toInsert.id,
      // ORIGINAL casing is preserved on the column; uniqueness is enforced by
      // the `lower(email)` index, which is exactly what Azure's lower-cased
      // email partition key did (azure-storage.ts:105-107).
      email: toInsert.email,
      name: toInsert.name,
      github_id: toInsert.gitHubId || null,
      microsoft_id: toInsert.microsoftId || null,
      azure_ad_id: toInsert.azureAdId || null,
      created_at: toIso(toInsert.createdTime || nowMs()),
    });

    if (error) {
      throw toStorageError(error);
    }

    return toInsert.id;
  }

  public getAccount(accountId: string): q.Promise<storage.Account> {
    return q(this.getAccountAsync(accountId));
  }

  private async getAccountAsync(accountId: string): Promise<storage.Account> {
    // Collapses Azure's two-hop pointer walk (azure-storage.ts:239-250) into one
    // primary-key read.
    const { data, error } = await this._client.from(TABLE_ACCOUNT).select(ACCOUNT_COLUMNS).eq("id", accountId).maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row: AccountRow = asRow<AccountRow>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified account does not exist.");
    }

    return SupabaseStorage.toAccount(row);
  }

  public getAccountByEmail(email: string): q.Promise<storage.Account> {
    return q(this.getAccountByEmailAsync(email));
  }

  private async getAccountByEmailAsync(email: string): Promise<storage.Account> {
    const { data, error } = await this._client
      .from(TABLE_ACCOUNT)
      .select(ACCOUNT_COLUMNS)
      // Case-INSENSITIVE, matching Azure: the email shortcut partition key was
      // lower-cased, so `Foo@x.com` and `foo@x.com` resolved to the same account
      // and a second registration was rejected as a duplicate.
      .ilike("email", escapeIlikeLiteral(email))
      .limit(1)
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row: AccountRow = asRow<AccountRow>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified e-mail address doesn't represent a registered user");
    }

    return SupabaseStorage.toAccount(row);
  }

  public updateAccount(email: string, updates: storage.Account): q.Promise<void> {
    return q(this.updateAccountAsync(email, updates));
  }

  private async updateAccountAsync(email: string, updates: storage.Account): Promise<void> {
    if (!email) {
      throw new Error("No account email");
    }

    // Azure's updateEntity ran in Merge mode over exactly these three
    // properties, and Merge ignores `undefined`. Building the patch from only
    // the defined keys reproduces that semantic exactly -- an OAuth link must
    // never null out the other two providers.
    const patch: { azure_ad_id?: string; github_id?: string; microsoft_id?: string } = {};
    if (updates.azureAdId !== undefined) patch.azure_ad_id = updates.azureAdId;
    if (updates.gitHubId !== undefined) patch.github_id = updates.gitHubId;
    if (updates.microsoftId !== undefined) patch.microsoft_id = updates.microsoftId;

    if (!Object.keys(patch).length) {
      return;
    }

    const { data, error } = await this._client
      .from(TABLE_ACCOUNT)
      .update(patch)
      .ilike("email", escapeIlikeLiteral(email))
      .select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<AccountRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified e-mail address doesn't represent a registered user");
    }
  }

  public getAccountIdFromAccessKey(accessKey: string): q.Promise<string> {
    return q(this.getAccountIdFromAccessKeyAsync(accessKey));
  }

  private async getAccountIdFromAccessKeyAsync(accessKey: string): Promise<string> {
    // The token is never stored; only sha256(token) is, and it migrates verbatim
    // from Azure (azure-storage.ts:1236-1239). That is what keeps every existing
    // CLI token, every developer's .code-push.config and the dashboard proxy's
    // CODEPUSH_AUTH_TOKEN working across the cutover.
    const nameHash: string = utils.hashWithSHA256(accessKey);

    const { data, error } = await this._client
      .from(TABLE_ACCESS_KEY)
      .select("account_id,expires_at")
      .eq("name_hash", nameHash)
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row = asRow<{ account_id: string; expires_at: string }>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound);
    }

    // Expired is DISTINCT from missing, as azure-storage.ts:294-296 has it. The
    // bearer strategy renders the two differently, and collapsing them turns
    // "your token expired, run `code-push-standalone login`" into a 500.
    if (nowMs() >= toEpochMs(row.expires_at)) {
      rejectStorage(storage.ErrorCode.Expired, "The access key has expired.");
    }

    return row.account_id;
  }

  // ── apps ────────────────────────────────────────────────────────────────────

  public addApp(accountId: string, app: storage.App, additionalOwnerAccountIds?: string[]): q.Promise<storage.App> {
    return q(this.addAppAsync(accountId, app, additionalOwnerAccountIds));
  }

  private async addAppAsync(accountId: string, app: storage.App, additionalOwnerAccountIds?: string[]): Promise<storage.App> {
    const toInsert: storage.App = storage.clone(app); // pass by value
    toInsert.id = shortid.generate();

    const creator: storage.Account = await this.getAccountAsync(accountId);

    const collabMap: storage.CollaboratorMap = {};
    collabMap[creator.email] = { accountId: accountId, permission: storage.Permissions.Owner };
    toInsert.collaborators = collabMap;

    // Default app owners (fail-closed: undefined/empty => no-op). De-duped by
    // accountId, seeded with the creator, exactly as the Azure/Json forks do.
    const seenOwnerAccountIds = new Set<string>([accountId]);
    const candidateOwnerAccountIds: string[] = (additionalOwnerAccountIds || []).filter((ownerAccountId: string) => {
      if (!ownerAccountId || seenOwnerAccountIds.has(ownerAccountId)) {
        return false;
      }
      seenOwnerAccountIds.add(ownerAccountId);
      return true;
    });

    for (const ownerAccountId of candidateOwnerAccountIds) {
      try {
        const ownerAccount: storage.Account = await this.getAccountAsync(ownerAccountId);
        if (!ownerAccount || !ownerAccount.email) continue;
        if (ownerAccount.email === creator.email) continue;
        if (toInsert.collaborators[ownerAccount.email]) continue;
        if (storage.isPrototypePollutionKey(ownerAccount.email)) continue;

        // Skip if this owner already OWNS an app of the same name: bare-name
        // resolution would become ambiguous for them (storage.ts findAppByName),
        // and the `codepush_app_collaborator_owner_name_uidx` partial unique
        // would turn the whole create into a 409.
        const ownerApps: storage.App[] = await this.getAppsAsync(ownerAccount.id);
        if (storage.NameResolver.isDuplicate(ownerApps, toInsert.name)) {
          console.log(
            `[default-app-owners] '${ownerAccount.email}' already owns an app named '${toInsert.name}'; skipping default-owner grant`
          );
          continue;
        }

        toInsert.collaborators[ownerAccount.email] = {
          accountId: ownerAccount.id,
          permission: storage.Permissions.Owner,
        };
      } catch (resolveError) {
        // Fail-open on a single unresolvable default owner: never fail app
        // creation over one, same as both existing backends.
        console.log(`[default-app-owners] WARNING: could not resolve/apply default owner account ${ownerAccountId}; skipping`);
      }
    }

    const createdAt: string = toIso(toInsert.createdTime || nowMs());

    const { error: appError } = await this._client
      .from(TABLE_APP)
      .insert({ id: toInsert.id, name: toInsert.name, created_at: createdAt });

    if (appError) {
      throw toStorageError(appError);
    }

    // `app_name` is maintained by 803's BEFORE INSERT trigger, but it is also
    // NOT NULL -- send it so the insert still works on a database where the
    // trigger has not landed yet.
    const collaboratorRows = Object.keys(toInsert.collaborators).map((collaboratorEmail: string) => ({
      app_id: toInsert.id,
      account_id: toInsert.collaborators[collaboratorEmail].accountId,
      email: collaboratorEmail,
      permission: toInsert.collaborators[collaboratorEmail].permission,
      app_name: toInsert.name,
      created_at: createdAt,
    }));

    const { error: collabError } = await this._client.from(TABLE_COLLABORATOR).insert(collaboratorRows);
    if (collabError) {
      // Roll the app row back by hand. There is no cross-statement transaction
      // over PostgREST, and an app with no owner row is invisible to getApps and
      // therefore undeletable through the API.
      await this._client.from(TABLE_APP).delete().eq("id", toInsert.id);
      throw toStorageError(collabError);
    }

    return toInsert;
  }

  public getApps(accountId: string): q.Promise<storage.App[]> {
    return q(this.getAppsAsync(accountId));
  }

  private async getAppsAsync(accountId: string): Promise<storage.App[]> {
    // Two indexed reads, replacing Azure's range scan plus one pointer follow
    // PER APP (azure-storage.ts:1271-1300).
    const { data: pointerData, error: pointerError } = await this._client
      .from(TABLE_COLLABORATOR)
      .select("app_id")
      .eq("account_id", accountId);

    if (pointerError) {
      throw toStorageError(pointerError);
    }

    const appIds: string[] = asRows<{ app_id: string }>(pointerData).map((row) => row.app_id);

    if (!appIds.length) {
      // Distinguish "this account owns nothing" ([]) from "this account does not
      // exist" (NotFound) -- storage.ts:124-127 requires the second.
      await this.getAccountAsync(accountId);
      return [];
    }

    const { data, error } = await this._client
      .from(TABLE_APP)
      .select(`${APP_COLUMNS},${TABLE_COLLABORATOR}(${COLLABORATOR_COLUMNS})`)
      .in("id", appIds);

    if (error) {
      throw toStorageError(error);
    }

    const rows = asRows<AppRow & { codepush_app_collaborator?: CollaboratorRow[] }>(data);
    return rows.map((row) => SupabaseStorage.toApp(row, row.codepush_app_collaborator || [], accountId));
  }

  public getApp(accountId: string, appId: string): q.Promise<storage.App> {
    return q(this.getAppAsync(accountId, appId));
  }

  private async getAppAsync(accountId: string, appId: string): Promise<storage.App> {
    // Deliberately does NOT reject when `accountId` is not a collaborator, which
    // is Azure's behaviour too (retrieveByAppHierarchy is keyed on the app
    // alone). Membership is enforced one layer up by
    // `management.ts:throwIfInvalidPermissions`, which reads the collaborator map
    // this returns and produces a 403 -- a NotFound here would turn every
    // permission failure into a 404 and break `addDiffInfoForPackage`.
    const { data, error } = await this._client
      .from(TABLE_APP)
      .select(`${APP_COLUMNS},${TABLE_COLLABORATOR}(${COLLABORATOR_COLUMNS})`)
      .eq("id", appId)
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row = asRow<AppRow & { codepush_app_collaborator?: CollaboratorRow[] }>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified app does not exist.");
    }

    return SupabaseStorage.toApp(row, row.codepush_app_collaborator || [], accountId);
  }

  public removeApp(accountId: string, appId: string): q.Promise<void> {
    return q(this.removeAppAsync(accountId, appId));
  }

  private async removeAppAsync(accountId: string, appId: string): Promise<void> {
    // AWAITED, unlike Azure's `cleanUpByAppHierarchy` (azure-storage.ts:1359-1361
    // fires `submitTransaction` with no `return`/`await`, so a failed delete
    // resolved as success) and unlike `removeAllCollaboratorsAppPointers`, which
    // swallowed failures through `q.allSettled`. `ON DELETE CASCADE` on
    // collaborators, deployments, packages, diff-blob links and metrics makes
    // this one statement correct for free.
    const { data, error } = await this._client.from(TABLE_APP).delete().eq("id", appId).select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<AppRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified app does not exist.");
    }
  }

  public updateApp(accountId: string, app: storage.App): q.Promise<void> {
    return q(this.updateAppAsync(accountId, app));
  }

  private async updateAppAsync(accountId: string, app: storage.App): Promise<void> {
    if (!app || !app.id) {
      throw new Error("No app id");
    }

    // `name` is the only mutable column: `collaborators` lives in its own table
    // now (it was a JSON STRING on the app row in Azure, read-modify-written on
    // every grant), `id` is the key and `createdTime` is history.
    if (app.name === undefined) {
      return;
    }

    // The rename propagates to `codepush_app_collaborator.app_name` through
    // 803's AFTER UPDATE trigger, which is what keeps the owner-name unique
    // index meaningful -- so a rename onto a name the owner already holds comes
    // back as 23505 -> AlreadyExists -> 409, not a silent duplicate.
    const { data, error } = await this._client.from(TABLE_APP).update({ name: app.name }).eq("id", app.id).select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<AppRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified app does not exist.");
    }
  }

  public transferApp(accountId: string, appId: string, email: string): q.Promise<void> {
    return q(this.transferAppAsync(accountId, appId, email));
  }

  private async transferAppAsync(accountId: string, appId: string, email: string): Promise<void> {
    if (storage.isPrototypePollutionKey(email)) {
      rejectStorage(storage.ErrorCode.Invalid, "Invalid email parameter");
    }

    const app: storage.App = await this.getAppAsync(accountId, appId);
    const targetAccount: storage.Account = await this.getAccountByEmailAsync(email);

    // Always use the casing stored on the account, never the caller's.
    const targetEmail: string = targetAccount.email;
    const requesterEmail: string = SupabaseStorage.getEmailForAccountId(app.collaborators, accountId);

    if (requesterEmail === targetEmail) {
      rejectStorage(storage.ErrorCode.AlreadyExists, "The given account already owns the app.");
    }

    const targetApps: storage.App[] = await this.getAppsAsync(targetAccount.id);
    if (storage.NameResolver.isDuplicate(targetApps, app.name)) {
      rejectStorage(
        storage.ErrorCode.AlreadyExists,
        `Cannot transfer ownership. An app with name "${app.name}" already exists for the given collaborator.`
      );
    }

    // Demote the current owner FIRST. The partial unique index
    // `(account_id, app_name) WHERE permission = 'Owner'` is per account, so the
    // ordering does not deadlock -- but doing it in this order means a failure
    // between the two statements leaves the app with an owner rather than none.
    if (requesterEmail) {
      const { error: demoteError } = await this._client
        .from(TABLE_COLLABORATOR)
        .update({ permission: storage.Permissions.Collaborator })
        .eq("app_id", appId)
        .eq("account_id", accountId);

      if (demoteError) {
        throw toStorageError(demoteError);
      }
    }

    const { error: promoteError } = await this._client.from(TABLE_COLLABORATOR).upsert(
      {
        app_id: appId,
        account_id: targetAccount.id,
        email: targetEmail,
        permission: storage.Permissions.Owner,
        app_name: app.name,
      },
      { onConflict: "app_id,account_id" }
    );

    if (promoteError) {
      throw toStorageError(promoteError);
    }
  }

  // ── collaborators ───────────────────────────────────────────────────────────

  public addCollaborator(accountId: string, appId: string, email: string): q.Promise<void> {
    return q(this.addCollaboratorAsync(accountId, appId, email));
  }

  private async addCollaboratorAsync(accountId: string, appId: string, email: string): Promise<void> {
    if (storage.isPrototypePollutionKey(email)) {
      rejectStorage(storage.ErrorCode.Invalid, "Invalid email parameter");
    }

    const app: storage.App = await this.getAppAsync(accountId, appId);
    const targetAccount: storage.Account = await this.getAccountByEmailAsync(email);

    if (app.collaborators[targetAccount.email]) {
      rejectStorage(storage.ErrorCode.AlreadyExists, "The given account is already a collaborator for this app.");
    }

    const { error } = await this._client.from(TABLE_COLLABORATOR).insert({
      app_id: appId,
      account_id: targetAccount.id,
      email: targetAccount.email,
      permission: storage.Permissions.Collaborator,
      app_name: app.name,
    });

    if (error) {
      // The check above is advisory; `codepush_app_collaborator_app_email_uidx`
      // is what actually makes a concurrent double-grant a 409 instead of two
      // rows. Azure had no constraint at all here -- it was read-modify-write on
      // a JSON string.
      throw toStorageError(error);
    }
  }

  public getCollaborators(accountId: string, appId: string): q.Promise<storage.CollaboratorMap> {
    return q(this.getCollaboratorsAsync(accountId, appId));
  }

  private async getCollaboratorsAsync(accountId: string, appId: string): Promise<storage.CollaboratorMap> {
    const app: storage.App = await this.getAppAsync(accountId, appId);
    return app.collaborators;
  }

  public removeCollaborator(accountId: string, appId: string, email: string): q.Promise<void> {
    return q(this.removeCollaboratorAsync(accountId, appId, email));
  }

  private async removeCollaboratorAsync(accountId: string, appId: string, email: string): Promise<void> {
    const app: storage.App = await this.getAppAsync(accountId, appId);
    const target: storage.CollaboratorProperties = app.collaborators[email];

    if (!target) {
      rejectStorage(storage.ErrorCode.NotFound, "The given email is not a collaborator for this app.");
    }

    if (target.permission === storage.Permissions.Owner) {
      // AlreadyExists is the wrong-looking code, but it is what both existing
      // backends return and `restErrorHandler` maps it to the 409 the CLI
      // expects. Changing it here would change the HTTP status of a live route.
      rejectStorage(storage.ErrorCode.AlreadyExists, "Cannot remove the owner of the app from collaborator list.");
    }

    const { data, error } = await this._client
      .from(TABLE_COLLABORATOR)
      .delete()
      .eq("app_id", appId)
      .eq("account_id", target.accountId)
      .select("account_id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<CollaboratorRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The given email is not a collaborator for this app.");
    }
  }

  public setCollaboratorPermission(accountId: string, appId: string, email: string, permission: string): q.Promise<void> {
    return q(this.setCollaboratorPermissionAsync(accountId, appId, email, permission));
  }

  private async setCollaboratorPermissionAsync(accountId: string, appId: string, email: string, permission: string): Promise<void> {
    if (permission !== storage.Permissions.Owner && permission !== storage.Permissions.Collaborator) {
      rejectStorage(storage.ErrorCode.Invalid, "Invalid permission parameter");
    }

    if (storage.isPrototypePollutionKey(email)) {
      rejectStorage(storage.ErrorCode.Invalid, "Invalid email parameter");
    }

    const app: storage.App = await this.getAppAsync(accountId, appId);
    const target: storage.CollaboratorProperties = app.collaborators[email];

    if (!target) {
      rejectStorage(storage.ErrorCode.NotFound, "The given email is not a collaborator for this app.");
    }

    // Idempotent: nothing to change if the permission already matches.
    if (target.permission === permission) {
      return;
    }

    if (permission === storage.Permissions.Collaborator && target.permission === storage.Permissions.Owner) {
      let ownerCount = 0;
      Object.keys(app.collaborators).forEach((collaboratorEmail: string) => {
        if (app.collaborators[collaboratorEmail].permission === storage.Permissions.Owner) {
          ownerCount++;
        }
      });

      if (ownerCount <= 1) {
        rejectStorage(storage.ErrorCode.Invalid, "Cannot remove the last owner of the app.");
      }
    }

    const { data, error } = await this._client
      .from(TABLE_COLLABORATOR)
      .update({ permission: permission })
      .eq("app_id", appId)
      .eq("account_id", target.accountId)
      .select("account_id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<CollaboratorRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The given email is not a collaborator for this app.");
    }
  }

  // ── deployments ─────────────────────────────────────────────────────────────

  public addDeployment(accountId: string, appId: string, deployment: storage.Deployment): q.Promise<string> {
    return q(this.addDeploymentAsync(accountId, appId, deployment));
  }

  private async addDeploymentAsync(accountId: string, appId: string, deployment: storage.Deployment): Promise<string> {
    // Parent existence check, the equivalent of Azure's `fetchParentPromise`
    // (azure-storage.ts:1216-1221).
    await this.requireApp(appId);

    const deploymentId: string = shortid.generate();

    const { error } = await this._client.from(TABLE_DEPLOYMENT).insert({
      id: deploymentId,
      app_id: appId,
      name: deployment.name,
      // NEVER regenerated. A deployment key is compiled into the native binary
      // and JS can override it only per-call, so a new key strands every fielded
      // till on that channel forever.
      deployment_key: deployment.key,
      label_counter: 0,
      created_at: toIso(deployment.createdTime || nowMs()),
    });

    if (error) {
      throw toStorageError(error);
    }

    deployment.id = deploymentId;
    return deploymentId;
  }

  public getDeployment(accountId: string, appId: string, deploymentId: string): q.Promise<storage.Deployment> {
    return q(this.getDeploymentAsync(accountId, appId, deploymentId));
  }

  private async getDeploymentAsync(accountId: string, appId: string, deploymentId: string): Promise<storage.Deployment> {
    const { data, error } = await this._client
      .from(TABLE_DEPLOYMENT)
      .select(`${DEPLOYMENT_COLUMNS},${TABLE_PACKAGE}(${PACKAGE_COLUMNS})`)
      // ID PAIR, never the bare leaf -- see the id-chain note at the top of this
      // file. `.eq("id", deploymentId)` alone would let the owner of app A read,
      // patch, release into and DELETE a deployment of app B.
      .eq("app_id", appId)
      .eq("id", deploymentId)
      // Top-`seq` package only: PostgREST applies an embedded `limit` per parent
      // row, so this is a one-round-trip "newest release for this deployment".
      .order("seq", { referencedTable: TABLE_PACKAGE, ascending: false })
      .limit(1, { referencedTable: TABLE_PACKAGE })
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row = asRow<DeploymentRowWithPackage>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified deployment does not exist.");
    }

    return SupabaseStorage.toDeployment(row, SupabaseStorage.newestEmbeddedPackage(row));
  }

  public getDeployments(accountId: string, appId: string): q.Promise<storage.Deployment[]> {
    return q(this.getDeploymentsAsync(accountId, appId));
  }

  private async getDeploymentsAsync(accountId: string, appId: string): Promise<storage.Deployment[]> {
    await this.requireApp(appId);

    const { data, error } = await this._client
      .from(TABLE_DEPLOYMENT)
      .select(`${DEPLOYMENT_COLUMNS},${TABLE_PACKAGE}(${PACKAGE_COLUMNS})`)
      .eq("app_id", appId)
      .order("seq", { referencedTable: TABLE_PACKAGE, ascending: false })
      .limit(1, { referencedTable: TABLE_PACKAGE });

    if (error) {
      throw toStorageError(error);
    }

    const rows = asRows<DeploymentRowWithPackage>(data);
    return rows.map((row) => SupabaseStorage.toDeployment(row, SupabaseStorage.newestEmbeddedPackage(row)));
  }

  public getDeploymentInfo(deploymentKey: string): q.Promise<storage.DeploymentInfo> {
    return q(this.getDeploymentInfoAsync(deploymentKey));
  }

  private async getDeploymentInfoAsync(deploymentKey: string): Promise<storage.DeploymentInfo> {
    const { data, error } = await this._client
      .from(TABLE_DEPLOYMENT)
      .select("id,app_id")
      .eq("deployment_key", deploymentKey)
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row = asRow<{ id: string; app_id: string }>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound);
    }

    return { appId: row.app_id, deploymentId: row.id };
  }

  public removeDeployment(accountId: string, appId: string, deploymentId: string): q.Promise<void> {
    return q(this.removeDeploymentAsync(accountId, appId, deploymentId));
  }

  private async removeDeploymentAsync(accountId: string, appId: string, deploymentId: string): Promise<void> {
    // AWAITED. `ON DELETE CASCADE` takes the package history, the diff-blob
    // links and the metrics rows with it -- Azure needed a separate
    // `deleteHistoryBlob` call and dropped its transaction on the floor.
    const { data, error } = await this._client.from(TABLE_DEPLOYMENT).delete().eq("app_id", appId).eq("id", deploymentId).select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<DeploymentRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified deployment does not exist.");
    }
  }

  public updateDeployment(accountId: string, appId: string, deployment: storage.Deployment): q.Promise<void> {
    return q(this.updateDeploymentAsync(accountId, appId, deployment));
  }

  private async updateDeploymentAsync(accountId: string, appId: string, deployment: storage.Deployment): Promise<void> {
    if (!deployment || !deployment.id) {
      throw new Error("No deployment id");
    }

    // `package` is deliberately not writable through here -- both existing
    // backends strip it, and the only legal way to add a release is
    // commitPackage (which owns the label counter).
    const patch: { name?: string; deployment_key?: string } = {};
    if (deployment.name !== undefined) patch.name = deployment.name;
    if (deployment.key !== undefined) patch.deployment_key = deployment.key;

    if (!Object.keys(patch).length) {
      return;
    }

    const { data, error } = await this._client
      .from(TABLE_DEPLOYMENT)
      .update(patch)
      .eq("app_id", appId)
      .eq("id", deployment.id)
      .select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<DeploymentRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified deployment does not exist.");
    }
  }

  // ── packages ────────────────────────────────────────────────────────────────

  public commitPackage(
    accountId: string,
    appId: string,
    deploymentId: string,
    appPackage: storage.Package
  ): q.Promise<storage.Package> {
    return q(this.commitPackageAsync(accountId, appId, deploymentId, appPackage));
  }

  private async commitPackageAsync(
    accountId: string,
    appId: string,
    deploymentId: string,
    appPackage: storage.Package
  ): Promise<storage.Package> {
    if (!deploymentId) throw new Error("No deployment id");
    if (!appPackage) throw new Error("No package specified");

    const toCommit: storage.Package = storage.clone(appPackage); // pass by value

    // The RPC only takes a deployment id, so the id-chain check has to happen
    // here or app A could release into app B's deployment.
    await this.requireDeployment(appId, deploymentId);

    // Azure stamped the releasing account's email inside commitPackage; the
    // dashboard renders it on the release row.
    const account: storage.Account = await this.getAccountAsync(accountId);
    toCommit.releasedBy = account.email;

    const committed: PackageRow = await this.callCommitRpc(deploymentId, toCommit, /*includeBlobIds=*/ true);
    const result: storage.Package = SupabaseStorage.toPackage(committed);

    await this.syncDiffBlobRows(committed.id, result.diffPackageMap);

    return result;
  }

  /**
   * ONE call to `codepush_commit_package`. The label allocation, the
   * previous-package `rollout = NULL` clear and the 50-row trim all happen
   * inside it, under the row lock the RPC takes on `codepush_deployment`.
   *
   * WHY THAT MATTERS: `azure-storage.ts:706-753` read the history blob, parsed
   * "vN" off the last entry, incremented, and overwrote the whole blob with no
   * lease, ETag or If-Match. Two concurrent releases both computed v(N+1) and
   * the second PUT destroyed the first. Do NOT reimplement this in TypeScript.
   */
  private async callCommitRpc(deploymentId: string, appPackage: storage.Package, includeBlobIds: boolean): Promise<PackageRow> {
    const payload: { [key: string]: unknown } = {
      appVersion: appPackage.appVersion,
      description: appPackage.description,
      packageHash: appPackage.packageHash,
      blobUrl: appPackage.blobUrl,
      manifestBlobUrl: appPackage.manifestBlobUrl,
      diffPackageMap: appPackage.diffPackageMap || {},
      isDisabled: !!appPackage.isDisabled,
      isMandatory: !!appPackage.isMandatory,
      rollout: appPackage.rollout === undefined || appPackage.rollout === null ? null : appPackage.rollout,
      size: appPackage.size,
      releaseMethod: appPackage.releaseMethod || null,
      originalDeployment: appPackage.originalDeployment || null,
      originalLabel: appPackage.originalLabel || null,
      releasedBy: appPackage.releasedBy || null,
      uploadTime: appPackage.uploadTime || nowMs(),
    };

    if (includeBlobIds) {
      payload.blobId = this.blobIdFromUrl(appPackage.blobUrl);
      payload.manifestBlobId = this.blobIdFromUrl(appPackage.manifestBlobUrl);
    } else {
      payload.blobId = null;
      payload.manifestBlobId = null;
    }

    const { data, error } = await this._client.rpc(RPC_COMMIT_PACKAGE, {
      p_deployment_id: deploymentId,
      p_package: payload,
      p_max_history: MAX_PACKAGE_HISTORY_LENGTH,
    });

    if (error) {
      // 23503 means the derived blob id is not in the ledger -- an imported
      // package whose blob row never landed, or a blobUrl pointing somewhere
      // else entirely. Losing the GC back-reference is a leak; failing the
      // release is a fleet-visible outage. Retry once without the ids and say so
      // in the log.
      if (includeBlobIds && String((error as PostgrestFailure).code) === "23503") {
        console.log(
          `[supabase-storage] WARNING: blob ledger row missing for deployment ${deploymentId}; ` +
            `committing the release without a blob back-reference (GC will not be able to see it)`
        );
        return this.callCommitRpc(deploymentId, appPackage, /*includeBlobIds=*/ false);
      }

      throw toStorageError(error);
    }

    // A function declared `RETURNS public.codepush_package` comes back as a
    // single JSON object; tolerate an array in case PostgREST is configured to
    // wrap it.
    const row: PackageRow = Array.isArray(data) ? asRow<PackageRow>(data[0]) : asRow<PackageRow>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified deployment does not exist.");
    }

    return row;
  }

  public clearPackageHistory(accountId: string, appId: string, deploymentId: string): q.Promise<void> {
    return q(this.clearPackageHistoryAsync(appId, deploymentId));
  }

  private async clearPackageHistoryAsync(appId: string, deploymentId: string): Promise<void> {
    await this.requireDeployment(appId, deploymentId);

    const { error } = await this._client.from(TABLE_PACKAGE).delete().eq("deployment_id", deploymentId);

    if (error) {
      throw toStorageError(error);
    }

    // `label_counter` is deliberately NOT reset -- see divergence (b) at the top
    // of this file. Resetting it would reissue `v1` for different bytes under an
    // index that now forbids the duplicate, i.e. the next release would 23505.
  }

  public getPackageHistoryFromDeploymentKey(deploymentKey: string): q.Promise<storage.Package[]> {
    return q(this.getPackageHistoryFromDeploymentKeyAsync(deploymentKey));
  }

  private async getPackageHistoryFromDeploymentKeyAsync(deploymentKey: string): Promise<storage.Package[]> {
    // Two reads rather than one embedded query, because an unknown deployment
    // key must reject NotFound (which is what both existing backends do, and
    // what the acquisition route turns into a 404) rather than resolve to an
    // empty history, which reads as "no update available" and is silent.
    const { data: deploymentData, error: deploymentError } = await this._client
      .from(TABLE_DEPLOYMENT)
      .select("id")
      .eq("deployment_key", deploymentKey)
      .maybeSingle();

    if (deploymentError) {
      throw toStorageError(deploymentError);
    }

    const deploymentRow = asRow<{ id: string }>(deploymentData);
    if (!deploymentRow) {
      rejectStorage(storage.ErrorCode.NotFound);
    }

    return this.readPackageHistory(deploymentRow.id);
  }

  public getPackageHistory(accountId: string, appId: string, deploymentId: string): q.Promise<storage.Package[]> {
    return q(this.getPackageHistoryAsync(appId, deploymentId));
  }

  private async getPackageHistoryAsync(appId: string, deploymentId: string): Promise<storage.Package[]> {
    await this.requireDeployment(appId, deploymentId);
    return this.readPackageHistory(deploymentId);
  }

  /**
   * ASCENDING BY `seq`. This is the single most fleet-breaking ordering in the
   * codebase, so it is centralised here.
   *
   * `utils/acquisition.ts:56` walks `for (let i = packageHistory.length - 1; i >= 0; i--)`
   * -- oldest-first is the contract. Hand it DESC and
   * `latestSatisfyingEnabledPackage` becomes the OLDEST enabled package: every
   * till in the fleet is offered a downgrade, at HTTP 200 with
   * `is_available: true`, with nothing logged anywhere.
   * `shouldMakeUpdateMandatory` inverts with it, and
   * `getLastPackageHashWithSameAppVersion` (management.ts:899) then picks the
   * wrong hash so the identical-release 409 guard stops working.
   *
   * A conformance harness must assert array ORDER, not set equality: json-storage
   * stores a real array and is ascending by construction, so a harness that
   * diffs sorted sets passes while production is inverted.
   */
  private async readPackageHistory(deploymentId: string): Promise<storage.Package[]> {
    const { data, error } = await this._client
      .from(TABLE_PACKAGE)
      .select(PACKAGE_COLUMNS)
      .eq("deployment_id", deploymentId)
      .order("seq", { ascending: true });

    if (error) {
      throw toStorageError(error);
    }

    return asRows<PackageRow>(data).map((row) => SupabaseStorage.toPackage(row));
  }

  public updatePackageHistory(accountId: string, appId: string, deploymentId: string, history: storage.Package[]): q.Promise<void> {
    return q(this.updatePackageHistoryAsync(appId, deploymentId, history));
  }

  /**
   * A TARGETED UPDATE PER CHANGED ROW, not a whole-array replace.
   *
   * Azure rewrote the entire history blob from the caller's snapshot
   * (azure-storage.ts:778-793). Its three callers each touch exactly one thing:
   * a rollout/isDisabled/description patch (management.ts:829), the diff-map
   * attachment that runs AFTER the response has been sent (management.ts:965,
   * 1376-1394), and history repair. Under the blob, a patch and a late diff
   * landing in either order silently discarded the other's write.
   *
   * Here the current rows are read back and only the columns that actually
   * differ are written, keyed on `(deployment_id, label)`. A late diff map and a
   * concurrent rollout patch now touch disjoint columns and both survive.
   */
  private async updatePackageHistoryAsync(appId: string, deploymentId: string, history: storage.Package[]): Promise<void> {
    if (!history || !history.length) {
      rejectStorage(storage.ErrorCode.Invalid, "Cannot clear package history from an update operation");
    }

    await this.requireDeployment(appId, deploymentId);

    const labels: string[] = history.map((entry) => entry.label).filter((label) => !!label);
    if (!labels.length) {
      return;
    }

    const { data, error } = await this._client
      .from(TABLE_PACKAGE)
      .select(PACKAGE_COLUMNS)
      .eq("deployment_id", deploymentId)
      .in("label", labels);

    if (error) {
      throw toStorageError(error);
    }

    const currentByLabel: { [label: string]: PackageRow } = {};
    asRows<PackageRow>(data).forEach((row) => {
      currentByLabel[row.label] = row;
    });

    for (const entry of history) {
      if (!entry.label) continue;

      const current: PackageRow = currentByLabel[entry.label];
      if (!current) {
        // The row was trimmed by the 50-release window (or deleted) between the
        // caller's read and this write. Azure would have resurrected it into the
        // blob; recreating it here would have to invent a `seq`, colliding with
        // the label/seq unique indexes. Skip it and say so.
        console.log(
          `[supabase-storage] updatePackageHistory: label ${entry.label} no longer exists on deployment ${deploymentId}; skipping`
        );
        continue;
      }

      const patch: { [column: string]: unknown } = {};

      if (entry.appVersion !== undefined && entry.appVersion !== current.app_version) {
        patch.app_version = entry.appVersion;
      }
      if (entry.description !== undefined && (entry.description || null) !== current.description) {
        patch.description = entry.description || null;
      }
      if (entry.isDisabled !== undefined && !!entry.isDisabled !== current.is_disabled) {
        patch.is_disabled = !!entry.isDisabled;
      }
      if (entry.isMandatory !== undefined && !!entry.isMandatory !== current.is_mandatory) {
        patch.is_mandatory = !!entry.isMandatory;
      }

      // `rollout` is three-valued in this codebase: a number (live rollout),
      // null (finished/cleared) and undefined (never set). A finished rollout is
      // written as null by management.ts:818, so null must be a real write.
      const nextRollout: number = entry.rollout === undefined ? null : entry.rollout;
      if (nextRollout !== current.rollout) {
        patch.rollout = nextRollout;
      }

      let diffMapChanged = false;
      if (entry.diffPackageMap && Object.keys(entry.diffPackageMap).length) {
        const currentMap: storage.PackageHashToBlobInfoMap = current.diff_package_map || {};
        if (JSON.stringify(entry.diffPackageMap) !== JSON.stringify(currentMap)) {
          patch.diff_package_map = entry.diffPackageMap;
          diffMapChanged = true;
        }
      }

      if (!Object.keys(patch).length) {
        continue;
      }

      const { error: updateError } = await this._client
        .from(TABLE_PACKAGE)
        .update(patch)
        .eq("deployment_id", deploymentId)
        .eq("label", entry.label);

      if (updateError) {
        throw toStorageError(updateError);
      }

      if (diffMapChanged) {
        await this.syncDiffBlobRows(current.id, entry.diffPackageMap);
      }
    }
  }

  // ── blobs ───────────────────────────────────────────────────────────────────

  public addBlob(blobId: string, addstream: stream.Readable, streamLength: number): q.Promise<string> {
    return q(this.addBlobAsync(blobId, addstream, streamLength));
  }

  /**
   * MEMORY: the whole bundle is materialised as a Buffer here, deliberately.
   *
   * `management.ts:925` hands us `fs.createReadStream(filePath)`, and
   * `@supabase/supabase-js`'s `upload()` accepts
   * `File | Blob | ArrayBuffer | ArrayBufferView | Buffer | ReadableStream<Uint8Array> | FormData | URLSearchParams | string`
   * -- a Node `fs.ReadStream` is NOT one of them, and passing one produces an
   * empty or corrupt object rather than an error. Azure had the same
   * constraint (`utils.streamToBuffer` at azure-storage.ts:798), so this is not
   * a regression, but it does mean that at release time the container holds
   * CONCURRENTLY: multer's `memoryStorage()` copy of the upload, the temp file
   * on disk, the zip walk in `generatePackageManifestFromZip`, and this buffer.
   * A ~30 MB bundle therefore needs ~4x that in headroom -- hence
   * `mem_limit: 2g` and `UPLOAD_SIZE_LIMIT_MB=100` on the container, and hence
   * never raising the upload limit "just in case".
   */
  private async addBlobAsync(blobId: string, addstream: stream.Readable, streamLength: number): Promise<string> {
    // DELIBERATELY NOT `utils.streamToBuffer`. That helper resolves
    // `Buffer.concat(...).buffer` -- the underlying ArrayBuffer. For any payload
    // under 4 KB, `Buffer.allocUnsafe` hands back a VIEW into Node's shared 8 KB
    // buffer pool at a non-zero byteOffset, so `.buffer` is the whole pool: the
    // bytes we want are not at offset 0 and the length is not the payload's.
    // `Buffer.from(thatArrayBuffer)` would therefore upload up to 8 KB of
    // unrelated pooled memory as the object. Bundles are far over the threshold
    // and were never affected; a small serialised manifest is exactly in range,
    // and a corrupt manifest silently disables diffing for that release.
    // Concatenating the chunks here keeps the offset/length that Buffer owns.
    const chunks: Buffer[] = [];
    for await (const chunk of addstream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body: Buffer = Buffer.concat(chunks);

    const contentType = "application/octet-stream";
    const path: string = this.blobPath(blobId);

    const { error: uploadError } = await this._objectClient.storage.from(this._bucket).upload(path, body, {
      contentType: contentType,
      // Blob ids are `base64(randomBytes(21)) + accountId`, so a genuine
      // collision is not a thing that happens; `upsert` is here so that a retry
      // of a half-finished release is idempotent instead of a 409.
      upsert: true,
      // The object at a given id is immutable by construction, so it can be
      // cached forever. This is the single biggest lever on Supabase egress,
      // which -- unlike Azure's first 100 GB -- is metered.
      cacheControl: "31536000",
    });

    if (uploadError) {
      throw toStorageError(uploadError, `Failed to upload blob ${blobId}`);
    }

    // The ledger row. `removeBlob()` has no caller anywhere in api/script and
    // removeApp/removeDeployment only ever deleted the history blob, so every
    // bundle, manifest and diff ever uploaded is still stored. This table is
    // what makes the GC sweep expressible at all; without a row here the object
    // is invisible to it forever.
    //
    // `account_id` stays null: `addBlob(blobId, stream, length)` (storage.ts:162)
    // carries no account argument. The id happens to END with the accountId
    // (utils/security.ts generateSecureKey), but parsing it back out is guesswork
    // and a wrong guess writes a false attribution into an audit-shaped column.
    const { error: ledgerError } = await this._client.from(TABLE_BLOB).upsert(
      {
        id: blobId,
        bucket: this._bucket,
        storage_path: path,
        size_bytes: body.byteLength,
        content_type: contentType,
        deleted_at: null,
      },
      { onConflict: "id" }
    );

    if (ledgerError) {
      throw toStorageError(ledgerError, `Failed to record blob ${blobId}`);
    }

    return blobId;
  }

  public getBlobUrl(blobId: string): q.Promise<string> {
    return q(this.getBlobUrlAsync(blobId));
  }

  /**
   * The PUBLIC url. NEVER a signed one.
   *
   * `Package.blobUrl` is written once (management.ts:928), copied VERBATIM by
   * Promote (:1139) and Rollback (:1240), echoed to devices as `download_url`,
   * cached by the SDK across restarts, and re-fetched by this server's own
   * differ weeks later with a bare `superagent.get`. A signed URL would expire
   * out from under all of that; a long-lived one would additionally couple every
   * fielded download to the project's JWT secret, so one rotation would kill OTA
   * for the whole fleet.
   *
   * This is not a downgrade from Azure either: that container was created with
   * `{ access: "blob" }` (anonymous public read) and `getBlobUrl` returned the
   * raw URL with no SAS. The secret is the unguessable key itself.
   */
  private async getBlobUrlAsync(blobId: string): Promise<string> {
    return `${this._blobUrlPrefix}${blobId}`;
  }

  public removeBlob(blobId: string): q.Promise<void> {
    return q(this.removeBlobAsync(blobId));
  }

  private async removeBlobAsync(blobId: string): Promise<void> {
    // Object first, ledger second. If the ledger were stamped first and the
    // object delete then failed, the GC would consider the blob collected and
    // never revisit it -- a permanent leak that no query can find again.
    const { error: removeError } = await this._objectClient.storage.from(this._bucket).remove([this.blobPath(blobId)]);

    if (removeError) {
      throw toStorageError(removeError, `Failed to remove blob ${blobId}`);
    }

    const { error: ledgerError } = await this._client
      .from(TABLE_BLOB)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", blobId);

    if (ledgerError) {
      throw toStorageError(ledgerError, `Failed to tombstone blob ${blobId}`);
    }
  }

  // ── access keys ─────────────────────────────────────────────────────────────

  public addAccessKey(accountId: string, accessKey: storage.AccessKey): q.Promise<string> {
    return q(this.addAccessKeyAsync(accountId, accessKey));
  }

  private async addAccessKeyAsync(accountId: string, accessKey: storage.AccessKey): Promise<string> {
    const toInsert: storage.AccessKey = storage.clone(accessKey); // pass by value
    toInsert.id = shortid.generate();

    const { error } = await this._client.from(TABLE_ACCESS_KEY).insert({
      id: toInsert.id,
      account_id: accountId,
      // Only the hash is ever stored -- same function, same value as Azure's
      // `name` column, so tokens survive the cutover untouched.
      name_hash: utils.hashWithSHA256(toInsert.name),
      friendly_name: toInsert.friendlyName,
      description: toInsert.description || null,
      created_by: toInsert.createdBy || null,
      is_session: !!toInsert.isSession,
      created_at: toIso(toInsert.createdTime || nowMs()),
      expires_at: toIso(toInsert.expires),
    });

    if (error) {
      // 23505 on `codepush_access_key_account_friendly_uidx` becomes
      // AlreadyExists -> 409 here rather than a 500, which matters because
      // session keys are named "Login-" + Date.now() with no duplicate check.
      throw toStorageError(error);
    }

    return toInsert.id;
  }

  public getAccessKey(accountId: string, accessKeyId: string): q.Promise<storage.AccessKey> {
    return q(this.getAccessKeyAsync(accountId, accessKeyId));
  }

  private async getAccessKeyAsync(accountId: string, accessKeyId: string): Promise<storage.AccessKey> {
    const { data, error } = await this._client
      .from(TABLE_ACCESS_KEY)
      .select(ACCESS_KEY_COLUMNS)
      // ID PAIR: without `account_id` any authenticated developer could read
      // another account's key metadata by id.
      .eq("account_id", accountId)
      .eq("id", accessKeyId)
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row = asRow<AccessKeyRow>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound);
    }

    return SupabaseStorage.toAccessKey(row);
  }

  public getAccessKeys(accountId: string): q.Promise<storage.AccessKey[]> {
    return q(this.getAccessKeysAsync(accountId));
  }

  private async getAccessKeysAsync(accountId: string): Promise<storage.AccessKey[]> {
    const { data, error } = await this._client
      .from(TABLE_ACCESS_KEY)
      .select(ACCESS_KEY_COLUMNS)
      .eq("account_id", accountId)
      .order("created_at", { ascending: true });

    if (error) {
      throw toStorageError(error);
    }

    const rows = asRows<AccessKeyRow>(data);

    if (!rows.length) {
      // Azure rejected NotFound when it could not find the PARENT account
      // entity; reproduce that, but only when there is nothing to return.
      await this.getAccountAsync(accountId);
      return [];
    }

    // Also fixes azure-storage.ts:868-872, which read only the FIRST PAGE
    // (`.byPage().next()`), so an account past one page of keys silently lost
    // the rest -- including from the duplicate-name check in management.ts:183.
    return rows.map((row) => SupabaseStorage.toAccessKey(row));
  }

  public removeAccessKey(accountId: string, accessKeyId: string): q.Promise<void> {
    return q(this.removeAccessKeyAsync(accountId, accessKeyId));
  }

  private async removeAccessKeyAsync(accountId: string, accessKeyId: string): Promise<void> {
    const { data, error } = await this._client
      .from(TABLE_ACCESS_KEY)
      .delete()
      .eq("account_id", accountId)
      .eq("id", accessKeyId)
      .select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<AccessKeyRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound);
    }
  }

  public updateAccessKey(accountId: string, accessKey: storage.AccessKey): q.Promise<void> {
    return q(this.updateAccessKeyAsync(accountId, accessKey));
  }

  private async updateAccessKeyAsync(accountId: string, accessKey: storage.AccessKey): Promise<void> {
    if (!accessKey) {
      throw new Error("No access key");
    }

    if (!accessKey.id) {
      throw new Error("No access key id");
    }

    const patch: { friendly_name?: string; description?: string; expires_at?: string; created_by?: string } = {};
    if (accessKey.friendlyName !== undefined) patch.friendly_name = accessKey.friendlyName;
    if (accessKey.description !== undefined) patch.description = accessKey.description;
    if (accessKey.createdBy !== undefined) patch.created_by = accessKey.createdBy;
    if (accessKey.expires !== undefined) patch.expires_at = toIso(accessKey.expires);

    if (!Object.keys(patch).length) {
      return;
    }

    // The `name_hash` is intentionally NOT updatable: the token itself cannot be
    // rotated in place, and Azure's second write here (the pointer entity) only
    // existed to keep the duplicated `expires` in sync -- there is one copy now.
    const { data, error } = await this._client
      .from(TABLE_ACCESS_KEY)
      .update(patch)
      .eq("account_id", accountId)
      .eq("id", accessKey.id)
      .select("id");

    if (error) {
      throw toStorageError(error);
    }

    if (!asRows<AccessKeyRow>(data).length) {
      rejectStorage(storage.ErrorCode.NotFound);
    }
  }

  // No-op for safety, so that we don't drop the wrong db -- identical to
  // AzureStorage.dropAll (azure-storage.ts:950-952). This is a real database
  // shared with nothing else, but "drop everything" reachable from a test helper
  // is not a button worth wiring up.
  public dropAll(): q.Promise<void> {
    return q(<void>null);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private blobPath(blobId: string): string {
    return `${BLOB_PREFIX}/${blobId}`;
  }

  /**
   * Recover a blob id from a URL this server minted.
   *
   * Only URLs under our own public prefix are accepted, because those are the
   * only ones guaranteed to have a `codepush_blob` ledger row (addBlob writes it,
   * and the Azure importer writes it). A URL from anywhere else -- an
   * un-migrated Azure blob, a hand-edited row -- yields null rather than a made
   * up id that would fail the foreign key and take a release down with it.
   */
  private blobIdFromUrl(url: string): string {
    if (!url || url.indexOf(this._blobUrlPrefix) !== 0) {
      return null;
    }

    const remainder: string = url.substring(this._blobUrlPrefix.length).split("?")[0].split("#")[0];
    return /^[A-Za-z0-9_-]+$/.test(remainder) ? remainder : null;
  }

  /**
   * Maintain `codepush_package_diff_blob`.
   *
   * Diff blobs are referenced ONLY as URLs nested inside the `diff_package_map`
   * JSONB, and Promote/Rollback copy those verbatim, so one diff blob has many
   * referrers. Without this child table, "is this blob still referenced?" is a
   * full scan plus a JSONB string parse -- the query nobody writes, which is how
   * the storage leak stays open. The GC sweep in step 8 reads exactly this table.
   *
   * Ids not present in the ledger are dropped rather than inserted: the FK would
   * reject them anyway, and a failure here must never fail a release that has
   * already been committed.
   */
  private async syncDiffBlobRows(packageId: number, diffPackageMap: storage.PackageHashToBlobInfoMap): Promise<void> {
    if (!packageId || !diffPackageMap) {
      return;
    }

    const sourceHashes: string[] = Object.keys(diffPackageMap);
    if (!sourceHashes.length) {
      return;
    }

    const candidates: { blobId: string; sourcePackageHash: string }[] = [];
    sourceHashes.forEach((sourcePackageHash: string) => {
      const info: storage.BlobInfo = diffPackageMap[sourcePackageHash];
      const blobId: string = info && this.blobIdFromUrl(info.url);
      if (blobId) {
        candidates.push({ blobId: blobId, sourcePackageHash: sourcePackageHash });
      }
    });

    if (!candidates.length) {
      return;
    }

    const { data, error } = await this._client
      .from(TABLE_BLOB)
      .select("id")
      .in(
        "id",
        candidates.map((candidate) => candidate.blobId)
      );

    if (error) {
      console.log(`[supabase-storage] WARNING: could not verify diff blob ledger rows: ${error.message}`);
      return;
    }

    const known = new Set<string>(asRows<{ id: string }>(data).map((row) => row.id));
    const rows = candidates
      .filter((candidate) => known.has(candidate.blobId))
      .map((candidate) => ({
        package_id: packageId,
        blob_id: candidate.blobId,
        source_package_hash: candidate.sourcePackageHash,
      }));

    if (!rows.length) {
      return;
    }

    const { error: upsertError } = await this._client
      .from(TABLE_PACKAGE_DIFF_BLOB)
      .upsert(rows, { onConflict: "package_id,source_package_hash" });

    if (upsertError) {
      console.log(`[supabase-storage] WARNING: could not record diff blob references: ${upsertError.message}`);
    }
  }

  /** Existence check for an app; NotFound otherwise. */
  private async requireApp(appId: string): Promise<void> {
    const { data, error } = await this._client.from(TABLE_APP).select("id").eq("id", appId).maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    if (!data) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified app does not exist.");
    }
  }

  /**
   * Existence check for a deployment ON THE GIVEN APP; NotFound otherwise.
   * This is the id-chain guard, and every package-level method goes through it.
   */
  private async requireDeployment(appId: string, deploymentId: string): Promise<DeploymentRow> {
    const { data, error } = await this._client
      .from(TABLE_DEPLOYMENT)
      .select(DEPLOYMENT_COLUMNS)
      .eq("app_id", appId)
      .eq("id", deploymentId)
      .maybeSingle();

    if (error) {
      throw toStorageError(error);
    }

    const row = asRow<DeploymentRow>(data);
    if (!row) {
      rejectStorage(storage.ErrorCode.NotFound, "The specified deployment does not exist.");
    }

    return row;
  }

  private static newestEmbeddedPackage(row: DeploymentRowWithPackage): PackageRow {
    const embedded: PackageRow[] = row.codepush_package || [];
    if (!embedded.length) {
      return null;
    }

    // PostgREST's per-parent `limit(1)` on the embedded resource already leaves
    // exactly the top-`seq` row here. The reduce is defensive: if that limit is
    // ever not applied (an older PostgREST, a config change), taking index 0
    // blindly would silently hydrate `.package` with the OLDEST release, which
    // is the same class of bug as returning history DESC.
    return embedded.reduce((best: PackageRow, candidate: PackageRow) => (!best || candidate.seq > best.seq ? candidate : best));
  }

  private static toAccount(row: AccountRow): storage.Account {
    const account: storage.Account = {
      id: row.id,
      email: row.email,
      name: row.name,
      createdTime: toEpochMs(row.created_at),
    };

    // Set only when present: `toRestAccount` builds `linkedProviders` from
    // truthiness, and an explicit null would still be dropped there -- but the
    // conformance harness diffs objects, and Azure simply had no property.
    if (row.github_id) account.gitHubId = row.github_id;
    if (row.microsoft_id) account.microsoftId = row.microsoft_id;
    if (row.azure_ad_id) account.azureAdId = row.azure_ad_id;

    return account;
  }

  private static toApp(row: AppRow, collaboratorRows: CollaboratorRow[], currentAccountId: string): storage.App {
    const collaborators: storage.CollaboratorMap = {};

    collaboratorRows.forEach((collaboratorRow: CollaboratorRow) => {
      if (storage.isPrototypePollutionKey(collaboratorRow.email)) {
        return;
      }

      const properties: storage.CollaboratorProperties = {
        accountId: collaboratorRow.account_id,
        permission: collaboratorRow.permission,
      };

      // `isCurrentAccount` is what `isOwnedByCurrentUser` and therefore
      // `NameResolver.findAppByName`'s ambiguity resolution run on.
      if (collaboratorRow.account_id === currentAccountId) {
        properties.isCurrentAccount = true;
      }

      collaborators[collaboratorRow.email] = properties;
    });

    return {
      id: row.id,
      name: row.name,
      createdTime: toEpochMs(row.created_at),
      collaborators: collaborators,
    };
  }

  private static toDeployment(row: DeploymentRow, packageRow: PackageRow): storage.Deployment {
    const deployment: storage.Deployment = {
      id: row.id,
      name: row.name,
      key: row.deployment_key,
      createdTime: toEpochMs(row.created_at),
    };

    // HYDRATED, not dropped. Three consumers depend on it: the unfinished-rollout
    // release guard (management.ts:887-893), the promote-to-unfinished guard
    // (:1118-1123) and the ERP CodePush page's current-release display. Azure kept
    // a duplicated JSON copy of the newest package on the deployment row; here it
    // is derived from the top-`seq` row so it cannot drift.
    //
    // ABSENT, not `null`, when there is no release. `converter.toRestDeployment`
    // copies this property through verbatim, so an explicit null would put
    // `"package": null` on the wire for every never-released deployment (25 of the
    // 40 on the live account) where Azure and JsonStorage both omit the key. Both
    // read as falsey in JS, but the JSON shape of the management API is consumed by
    // the CLI and the ERP page and there is no reason to change it during a
    // migration whose whole acceptance test is a byte-comparison against Azure.
    if (packageRow) {
      deployment.package = SupabaseStorage.toPackage(packageRow);
    }

    return deployment;
  }

  private static toPackage(row: PackageRow): storage.Package {
    const appPackage: storage.Package = {
      appVersion: row.app_version,
      blobUrl: row.blob_url,
      description: row.description,
      isDisabled: row.is_disabled,
      isMandatory: row.is_mandatory,
      label: row.label,
      manifestBlobUrl: row.manifest_blob_url,
      packageHash: row.package_hash,
      rollout: row.rollout,
      size: Number(row.size_bytes),
      uploadTime: toEpochMs(row.uploaded_at),
    };

    // diffPackageMap is left UNDEFINED when empty, not `{}`. This is load
    // bearing: `addDiffInfoForPackage` (management.ts:1358) attaches the diff map
    // only to an entry for which `!history[i].diffPackageMap` holds, so an empty
    // object would be truthy, the attach would never fire, and every device would
    // download the full ~30 MB bundle forever instead of a ~1 MB diff. Azure's
    // JSON round trip had no key at all in that case.
    if (row.diff_package_map && Object.keys(row.diff_package_map).length) {
      appPackage.diffPackageMap = row.diff_package_map;
    }

    if (row.release_method) appPackage.releaseMethod = row.release_method;
    if (row.original_deployment) appPackage.originalDeployment = row.original_deployment;
    if (row.original_label) appPackage.originalLabel = row.original_label;
    if (row.released_by) appPackage.releasedBy = row.released_by;

    return appPackage;
  }

  private static toAccessKey(row: AccessKeyRow): storage.AccessKey {
    const accessKey: storage.AccessKey = {
      id: row.id,
      // The HASH, exactly as Azure returned it (insertAccessKey hashed `name`
      // before storing and getAccessKey handed the stored value back). The
      // duplicate-name check in management.ts:183 compares a raw token against
      // this and therefore never matches -- the friendlyName comparison on the
      // next line is what actually guards. Preserved rather than "fixed",
      // because changing it changes which requests 409.
      name: row.name_hash,
      friendlyName: row.friendly_name,
      createdBy: row.created_by,
      createdTime: toEpochMs(row.created_at),
      expires: toEpochMs(row.expires_at),
    };

    if (row.description) accessKey.description = row.description;
    if (row.is_session) accessKey.isSession = true;

    return accessKey;
  }

  private static getEmailForAccountId(collaborators: storage.CollaboratorMap, accountId: string): string {
    if (collaborators) {
      for (const email of Object.keys(collaborators)) {
        if (collaborators[email].accountId === accountId) {
          return email;
        }
      }
    }

    return null;
  }
}
