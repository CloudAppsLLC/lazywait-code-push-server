// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// =============================================================================
// STORAGE CONFORMANCE HARNESS  --  JsonStorage vs SupabaseStorage
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The Azure -> Supabase rehost swaps the entire data layer of this server for a
// new `Storage` implementation. `Storage` (script/storage/storage.ts) is an
// interface of 26 methods with a contract that is mostly UNWRITTEN: it lives in
// the shape of the values the acquisition and management routes expect back.
// A backend can satisfy every type signature, compile clean, pass a smoke test,
// and still hand the fleet a downgrade at HTTP 200.
//
// So this harness does not test "does the method return a thing". It runs ONE
// identical lifecycle against JsonStorage (the reference implementation) and,
// when configured, against SupabaseStorage, and asserts the handful of
// properties that -- if they break -- break every till in the field silently.
//
// THE SINGLE MOST IMPORTANT THING IN HERE
// ---------------------------------------
// Package history is ORDER-SIGNIFICANT, ASCENDING (oldest first).
// utils/acquisition.ts:56 walks it backwards (`for (i = length - 1; i >= 0; i--)`)
// and commitPackage reads `history[length - 1]` as "the latest release".
// Hand those callers a DESCENDING array and `latestSatisfyingEnabledPackage`
// becomes the OLDEST enabled package: every device in the fleet is offered a
// DOWNGRADE, at HTTP 200, with `is_available: true`, and nothing is logged
// anywhere. `shouldMakeUpdateMandatory` inverts with it, and
// `getLastPackageHashWithSameAppVersion` (management.ts:899) starts picking the
// wrong hash so the identical-release 409 guard stops working too.
//
// A harness that compares SORTED SETS of packages passes on all of that.
// JsonStorage stores a real array and is ascending by construction, so the
// sorted-set version of this file would be green forever while production is
// inverted. EVERY history assertion below is therefore an ARRAY assertion:
// deepStrictEqual over the array (index by index), plus explicit head/tail
// pinning so that a reversal cannot hide behind matching contents.
// DO NOT "simplify" any of them into a set comparison.
//
// HOW TO RUN
// ----------
//   cd api
//   npx tsc                                  # compiles ./script and ./test into ./bin
//   node ./bin/test/storage-conformance.js   # JsonStorage leg only (no Supabase)
//
// The file is ALSO a valid mocha suite. `mocha` is not currently a dependency of
// this fork (only @types/mocha is), so the standalone entry point above is the
// path that works today; if mocha is ever added, `mocha bin/test/**/*.js` picks
// this up with no edits -- the describe/it tree and the standalone runner share
// the same check list.
//
// ENV VARS -- THE SUPABASE LEG
// ----------------------------
//   TEST_SUPABASE_STORAGE=1
//       THE GATE. Absent  -> the Supabase leg is SKIPPED CLEANLY (the suite is
//                            still green; that is the intended default and is
//                            how this file runs in a checkout with no cloud
//                            credentials). Named after the existing
//                            TEST_AZURE_STORAGE gate in test/storage.ts.
//       Present -> script/storage/supabase-storage.ts MUST exist and MUST be
//                  constructible, or the suite FAILS. Asking for the leg and
//                  silently not getting it is the failure mode this avoids.
//
// SupabaseStorage reads its own configuration from the environment (the harness
// constructs it with no arguments, exactly as test/storage.ts constructs
// AzureStorage). Those variables are ITS contract, not this harness's, but they
// are listed here because you cannot turn the leg on without them:
//
//   SUPABASE_URL                 project REST endpoint
//   SUPABASE_CODEPUSH_JWT        PostgREST JWT carrying {"role":"codepush_api"}.
//                                NOT the service-role key -- see migration
//                                803_codepush_core.sql, "ACCESS: NOT
//                                service_role". Handing this container the
//                                service-role key gives a 12-year-old fork
//                                pos_orders and hrms_employees.
//   SUPABASE_CODEPUSH_BUCKET     bundle bucket; default 'LazyWaitCodePush'
//                                (dedicated bucket, path 'blobs/{blobId}' --
//                                this SUPERSEDES the migration design's shared
//                                'LazyWaitStorage' + 'codepush/' prefix).
//   SUPABASE_CODEPUSH_STORAGE_KEY  optional; separate key for the Storage API
//   SUPABASE_CODEPUSH_PUBLIC_URL   optional; public base URL for bundle reads
//
// (Names verified against script/storage/supabase-storage.ts. This harness never
// reads them itself -- it constructs SupabaseStorage with no arguments and lets
// the adapter resolve its own configuration, so an adapter that renames a
// variable does not need an edit here.)
//
// Point the leg at the DEV Supabase project. The sequence below writes real
// rows: one account, two apps, two deployments, ~8 packages. Step 12 removes
// both apps (which is itself a check -- see "removeApp AWAITS its cascade"), so
// the cascade takes the deployments, packages and collaborator rows with them.
// `Storage` has no account-delete verb, so ONE codepush_account row per run is
// left behind by design; every run uses a fresh RUN_ID-scoped email and
// deployment key so repeat runs cannot collide on the schema's unique indexes.
// Do not run this against production.
//
// =============================================================================
// DELIBERATE DIVERGENCES -- READ BEFORE YOU "FIX" A RED
// =============================================================================
//
// (1) LABEL TEXT AFTER clearPackageHistory. EXEMPT FROM THE CROSS-BACKEND DIFF.
//     Azure (getNextLabel, azure-storage.ts:1403-1404) and JsonStorage
//     (commitPackage: `"v" + packageHistory.length`) both RESTART AT "v1" after a
//     history clear. That reuses the label v1 for a completely different set of
//     bytes -- and a device that has v1 installed and cached then reports a label
//     the server resolves to something else entirely.
//     The new schema's `codepush_deployment.label_counter` is MONOTONIC and never
//     resets (803_codepush_core.sql), so the first release after a clear is v4,
//     v5, ... whatever comes next. THIS IS ON PURPOSE. It is also enforced by
//     codepush_package_deployment_label_uidx, so "fixing" the red by resetting the
//     counter does not restore Azure's behaviour -- it reintroduces label reuse
//     under a unique index that now forbids it, and the second post-clear release
//     23505s the release pipeline dead.
//     => After the clear this harness compares label ORDERING (strictly
//        increasing ordinals, array position) and never label TEXT.
//
// (2) `deployment.package` AFTER clearPackageHistory.
//     JsonStorage deletes it. Azure does NOT (its updateEntity runs in Merge
//     mode, which cannot remove a property, so a ghost "current release" survives
//     a history clear). The new schema deletes -- JsonStorage is the correct
//     reference here, and this harness asserts the delete.
//
// (3) checkHealth(). JsonStorage rejects unconditionally ("Should not be running
//     JSON storage in production"). Any real backend must RESOLVE, or /health
//     500s (the health router chains storage.checkHealth). Asserted per backend,
//     exempt from the diff.
//
// (4) THE ID-CHAIN PROBE, AND IT IS THE UGLY ONE.
//     storage.ts:117-119 states the contract: "The Storage implementation should
//     verify that the whole specified id chain is correct, not just the leaf id."
//     Azure enforced it STRUCTURALLY -- retrieveByAppHierarchy partitions on
//     `appId <appId>`, so another app's deployment id is simply not in the
//     partition it reads.
//     JsonStorage DOES NOT. `getDeployment(accountId, appId, deploymentId)`
//     checks only that all three EXIST; it never checks that the deployment
//     belongs to that app. Fetching app B's deployment through app A's id
//     SUCCEEDS. (removeDeployment is the one method that does check, and it
//     throws synchronously rather than rejecting.)
//     A bare `.eq('id', deploymentId)` in the Supabase adapter reproduces that
//     hole against a real multi-tenant database, where it is a cross-tenant IDOR:
//     read, patch, release-into or DELETE another app's deployment. Migration 803
//     ships `codepush_deployment_app_id_uk UNIQUE (app_id, id)` precisely so the
//     CORRECT query is cheap and the wrong one is reviewable.
//     => This harness pins the expectation PER BACKEND: JsonStorage is recorded
//        as leaking (so the suite stays green and the defect stays visible and
//        documented), every other backend MUST reject. Do not "harmonise" these
//        by loosening the Supabase side.
//
// (5) `diffPackageMap` when unset. The schema column defaults to '{}'::jsonb;
//     JsonStorage round-trips `undefined`. Normalised to {} on both sides for the
//     diff. Both are correct for their layer; converter.ts tolerates either.
//
// =============================================================================
// WHAT THIS HARNESS DELIBERATELY DOES NOT COVER
// =============================================================================
//   * Blob bytes. getBlobUrl() on JsonStorage spins up a real express server and
//     leaks the handle; and the property that actually matters -- "an anonymous
//     off-network GET of a real bundle returns 200 and the right sha256" -- is a
//     network fact this process cannot establish. That belongs to the replay
//     harness (design §D), and it is the #1 fleet risk in the whole migration.
//   * HTTP status codes. The unfinished-rollout 409 is raised by the ROUTE
//     (management.ts:887-893), not by Storage. What this harness proves is the
//     storage-level fact the 409 is built on: getDeployment() hydrates `.package`
//     from the top-seq row, carrying its `rollout` and `isDisabled`. It then
//     evaluates management.ts's own predicate (imported, not re-typed) against
//     that value and asserts it says REJECT. If `.package` is dropped or stale,
//     that guard silently stops firing and unfinished rollouts get released over.
//   * Metrics, collaborators, access keys, NameResolver. Covered by test/storage.ts.
// =============================================================================

import * as assert from "assert";

import { JsonStorage } from "../script/storage/json-storage";
// Importing this ALSO registers its own mocha describe() when mocha is present;
// the standalone runner below calls it explicitly. It rides in
// `npm run test:conformance` on purpose -- the Redis replacement (in-process
// response cache + Postgres metrics) is part of the same cutover, and it fails
// just as silently as a wrong Storage backend does.
import { runMetricsManagerChecks } from "./metrics-manager-conformance";
import * as storageTypes from "../script/storage/storage";
import { isUnfinishedRollout } from "../script/utils/rollout-selector";

// ---------------------------------------------------------------------------
// Fixtures. Everything is DETERMINISTIC on purpose: two backends can only be
// diffed field-by-field if neither side is allowed to invent a value. The only
// non-deterministic inputs are the ids the backends generate themselves, and
// those are aliased away before the diff (see IdAliases).
// ---------------------------------------------------------------------------

// A fixed instant, not Date.now(): uploadTime round-trips through
// to_timestamp(uploadTime / 1000.0) in the schema, and a diffable transcript
// needs a value both legs agree on. Whole seconds dodge any float wobble in
// that conversion.
const BASE_UPLOAD_TIME = 1_700_000_000_000;

const APP_VERSION = "1.0.0";

// ONE run id, computed once and shared by BOTH legs. This is the only
// non-deterministic value in the fixtures and it has to be exactly this shape:
//   * shared between the legs, or the cross-backend diff trips over the fixture
//     values themselves rather than over a real disagreement;
//   * fresh per process run, because the real schema enforces uniqueness that an
//     in-memory JsonStorage does not. A constant email 23505s on
//     codepush_account_email_lower_uidx and a constant deployment key 23505s on
//     codepush_deployment_key_uidx the SECOND time the Supabase leg is run
//     against the same project -- which is every time after the first.
// Charset stays inside utils/validation.ts's ^[a-zA-Z0-9_-]+$ so the values are
// legal deployment keys.
const RUN_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

// EXPLICIT deployment keys. management.ts:638 is
// `storageDeployment.key = restDeployment.key || security.generateSecureKey(...)`,
// i.e. the caller may pin the key -- and the whole data migration depends on
// that path working, because a deployment key is compiled into every shipped
// binary and a regenerated one strands every fielded till on that channel
// forever. A backend that ignores the supplied key and mints its own passes
// every other test in this repo. Length stays inside validation's 10..100.
const DEPLOYMENT_KEY_A = `conformance-a-${RUN_ID}`;
const DEPLOYMENT_KEY_B = `conformance-b-${RUN_ID}`;

const ACCOUNT_EMAIL = `conformance-${RUN_ID}@lazywait.invalid`;

interface IdAliases {
  [realId: string]: string;
}

interface Observation {
  step: string;
  value: unknown;
  // True for observations recorded at or after clearPackageHistory, where label
  // TEXT legitimately differs between backends (divergence (1)).
  labelTextIsExempt?: boolean;
}

interface Recording {
  backend: string;
  steps: Observation[];
  byStep: Map<string, Observation>;
  aliases: IdAliases;
}

type StorageFactory = () => storageTypes.Storage;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// q promises are thenable but not native; normalise at the boundary so the
// sequence below can be plain async/await. (Design §C.5: the adapter keeps
// returning q.Promise, so this stays necessary.)
function toNative<T>(promise: { then: (onOk: (value: T) => void, onErr: (reason: unknown) => void) => unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    promise.then(resolve, reject);
  });
}

interface RejectionResult {
  rejected: boolean;
  code?: storageTypes.ErrorCode;
}

// Records whether a call rejected instead of asserting immediately: the id-chain
// probe has a different EXPECTED outcome per backend (divergence (4)), so the
// observation and the expectation have to stay separable.
async function observeRejection<T>(promise: {
  then: (onOk: (value: T) => void, onErr: (reason: unknown) => void) => unknown;
}): Promise<RejectionResult> {
  try {
    await toNative<T>(promise);
    return { rejected: false };
  } catch (reason) {
    const storageError = reason as storageTypes.StorageError;
    return { rejected: true, code: storageError && storageError.code };
  }
}

// "v7" -> 7. Every label this server has ever minted is `"v" + <integer>`
// (azure-storage.ts getNextLabel, json-storage commitPackage, and
// codepush_commit_package's `'v' || v_seq`). Ordering assertions after a history
// clear compare these ordinals, never the text.
function labelOrdinal(label: string): number {
  const match = /^v(\d+)$/.exec(label);
  assert.ok(match, `label ${JSON.stringify(label)} is not of the form v<N>; ordering cannot be established`);
  return Number(match[1]);
}

function makeRelease(index: number, overrides?: Partial<storageTypes.Package>): storageTypes.Package {
  const release: storageTypes.Package = {
    appVersion: APP_VERSION,
    blobUrl: `https://blobs.invalid/bundle-${index}.zip`,
    description: `conformance release ${index}`,
    isDisabled: false,
    isMandatory: false,
    manifestBlobUrl: `https://blobs.invalid/manifest-${index}.json`,
    packageHash: `hash-${index}`,
    rollout: null,
    size: 1000 + index,
    uploadTime: BASE_UPLOAD_TIME + index * 60_000,
    releaseMethod: storageTypes.ReleaseMethod.Upload,
  };

  return Object.assign(release, overrides || {});
}

// ---------------------------------------------------------------------------
// Normalisation for the cross-backend diff.
//
// Strips the two classes of value that are ALLOWED to differ -- generated ids
// (JsonStorage mints "id_0", "id_1"; the schema keeps shortid text) and, after a
// history clear, label text -- and nothing else. In particular it NEVER sorts:
// arrays stay arrays in their observed order, because the order IS the contract.
// ---------------------------------------------------------------------------

const EXEMPT_LABEL_PLACEHOLDER = "<label-text-exempt>";

function normalize(value: unknown, aliases: IdAliases, exemptLabelText: boolean): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return Object.prototype.hasOwnProperty.call(aliases, value) ? aliases[value] : value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    // Index-preserving. Do not sort. Do not dedupe.
    return value.map((entry) => normalize(entry, aliases, exemptLabelText));
  }

  const source = value as { [key: string]: unknown };
  const result: { [key: string]: unknown } = {};

  Object.keys(source)
    .sort() // key order only -- object key order is not part of any contract
    .forEach((key) => {
      if (key === "isCurrentAccount") {
        return; // computed per-caller, not stored
      }

      // `releasedBy` is EXEMPT because JsonStorage is not the reference for it.
      //
      // AzureStorage -- the PRODUCTION backend -- sets it on every commit
      // (`appPackage.releasedBy = account.email`, azure-storage.ts:728).
      // JsonStorage never implements it: `grep releasedBy json-storage.ts`
      // returns nothing. So a backend that PRESERVES releasedBy agrees with
      // production and disagrees with the in-memory stub, and a cross-backend
      // diff reads that as a failure the wrong way round.
      //
      // It is not cosmetic: releasedBy is the "Released By" column of
      // `code-push deployment history`. A backend that dropped it to match
      // JsonStorage would blank that column for every release after the
      // migration -- a silent regression the diff would have called a pass.
      //
      // DROPPED, not placeholdered. The divergence is the key's PRESENCE, not
      // its value: SupabaseStorage emits `releasedBy`, JsonStorage omits the
      // property altogether, so normalising the value still leaves one side
      // with a key the other lacks and the deep-equal still fails.
      if (key === "releasedBy") {
        return;
      }

      // `rollout` is EXEMPT ONLY WHERE IT IS EMPTY, and only because Postgres
      // cannot represent the distinction this codebase draws in memory.
      //
      // rollout is three-valued here: a NUMBER (live rollout), NULL (a rollout
      // that finished -- codepush_commit_package clears the previous package's,
      // mirroring azure-storage.ts:730-735) and UNDEFINED (never set). An
      // INTEGER column has one empty state, so a package that never had a
      // rollout and one whose rollout finished both read back as NULL, while
      // JsonStorage keeps live objects and still has `undefined` for the first.
      //
      // Unobservable in behaviour: every read site (rollout-selector.ts:27,
      // utils/acquisition.ts:69, the management.ts:887-893 unfinished-rollout
      // guard) tests truthiness, and null and undefined are both falsy. So this
      // is a JSON-shape difference with no functional consequence, and NOT a
      // reason to change the adapter -- omitting on null would lose exactly the
      // same information in the other direction.
      //
      // A NUMERIC rollout is still compared strictly: only empty is exempt, so a
      // backend that dropped or altered a LIVE rollout percentage still fails.
      if (key === "rollout" && (source[key] === null || source[key] === undefined)) {
        return;
      }

      if (exemptLabelText && (key === "label" || key === "originalLabel")) {
        result[key] = source[key] === null || source[key] === undefined ? null : EXEMPT_LABEL_PLACEHOLDER;
        return;
      }

      if (key === "diffPackageMap" && (source[key] === null || source[key] === undefined)) {
        result[key] = {}; // divergence (5)
        return;
      }

      result[key] = normalize(source[key], aliases, exemptLabelText);
    });

  return result;
}

// ---------------------------------------------------------------------------
// THE SEQUENCE
//
// account -> two apps -> deployment with an EXPLICIT key -> 3 releases ->
// release over an unfinished rollout (must be refused) -> promote -> rollback ->
// patch rollout -> clear history -> two post-clear releases (label divergence).
//
// Promote / rollback / rollout-patch are performed here the way the ROUTES
// perform them (management.ts), because Storage has no such verbs -- they are
// each a read of the history plus one commitPackage or updatePackageHistory. The
// field-for-field construction below is copied from management.ts so that a
// backend which mangles releaseMethod / originalLabel / originalDeployment is
// caught here rather than by a developer wondering why `deployment history`
// prints blanks.
// ---------------------------------------------------------------------------

interface SequenceProgress {
  lastStep: string;
}

// The sequence is one long chain and any link can throw. Without this, a backend
// that breaks at step 4 reports a bare NotFound stack and the reader has to
// reconstruct where it was -- so name the last step that completed.
async function runSequenceGuarded(backend: string, factory: StorageFactory): Promise<Recording> {
  const progress: SequenceProgress = { lastStep: "(before the first step)" };
  try {
    return await runSequence(backend, factory, progress);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const wrapped = new Error(
      `${backend}: the conformance sequence aborted after step ${JSON.stringify(progress.lastStep)} -- ${message}`
    );
    // Keep the original stack UNDER the contextual message rather than instead of
    // it: the standalone runner prints the error object, so overwriting .stack
    // would throw the step name away again.
    if (reason instanceof Error && reason.stack) {
      wrapped.stack = `${wrapped.message}
--- original ---
${reason.stack}`;
    }
    throw wrapped;
  }
}

async function runSequence(backend: string, factory: StorageFactory, progress: SequenceProgress): Promise<Recording> {
  const storage: storageTypes.Storage = factory();
  const steps: Observation[] = [];
  const byStep = new Map<string, Observation>();
  const aliases: IdAliases = {};

  function record(step: string, value: unknown, labelTextIsExempt?: boolean): void {
    assert.ok(!byStep.has(step), `duplicate step name ${JSON.stringify(step)} in the conformance sequence`);
    const observation: Observation = { step, value, labelTextIsExempt };
    steps.push(observation);
    byStep.set(step, observation);
    progress.lastStep = step;
  }

  // -- 0. health ------------------------------------------------------------
  // Divergence (3): recorded, exempt from the diff, asserted per backend.
  const health = await observeRejection(storage.checkHealth());
  record("health.rejected", health.rejected);

  // -- 1. account -----------------------------------------------------------
  const accountId: string = await toNative<string>(
    storage.addAccount({
      createdTime: BASE_UPLOAD_TIME,
      email: ACCOUNT_EMAIL,
      name: "conformance account",
    })
  );
  aliases[accountId] = "<accountId>";
  record("account.roundTrip", await toNative<storageTypes.Account>(storage.getAccount(accountId)));

  // -- 2. two apps ----------------------------------------------------------
  // App B exists only to make the id-chain probe possible: two sibling apps
  // under ONE account, so a leak cannot be excused as "well, it is the same
  // owner anyway" -- it is still the wrong app, and in the real schema the same
  // query shape crosses tenants.
  const appA: storageTypes.App = await toNative<storageTypes.App>(
    storage.addApp(accountId, { createdTime: BASE_UPLOAD_TIME, name: "ConformanceAppA" })
  );
  const appB: storageTypes.App = await toNative<storageTypes.App>(
    storage.addApp(accountId, { createdTime: BASE_UPLOAD_TIME, name: "ConformanceAppB" })
  );
  aliases[appA.id] = "<appA>";
  aliases[appB.id] = "<appB>";
  record("appA.roundTrip", await toNative<storageTypes.App>(storage.getApp(accountId, appA.id)));

  // -- 3. deployments with EXPLICIT keys ------------------------------------
  const deploymentAId: string = await toNative<string>(
    storage.addDeployment(accountId, appA.id, { createdTime: BASE_UPLOAD_TIME, name: "Production", key: DEPLOYMENT_KEY_A })
  );
  const deploymentBId: string = await toNative<string>(
    storage.addDeployment(accountId, appB.id, { createdTime: BASE_UPLOAD_TIME, name: "Production", key: DEPLOYMENT_KEY_B })
  );
  aliases[deploymentAId] = "<deploymentA>";
  aliases[deploymentBId] = "<deploymentB>";

  const freshDeploymentA = await toNative<storageTypes.Deployment>(storage.getDeployment(accountId, appA.id, deploymentAId));
  record("deploymentA.key", freshDeploymentA.key);
  // Fail FAST and by name. Every step after this one addresses the deployment by
  // its key, so a backend that regenerated it takes the rest of the sequence down
  // with a bare NotFound and no hint as to why -- and "the key was regenerated on
  // import" is the single most expensive mistake available in this migration.
  assert.strictEqual(
    freshDeploymentA.key,
    DEPLOYMENT_KEY_A,
    `${backend}: addDeployment ignored the explicit deployment key and minted its own. A deployment key is compiled into every ` +
      `shipped binary (strings.xml / Info.plist / lazywaitone.cpp) and JS can override it only per call -- regenerating one ` +
      `strands every fielded till on that channel forever. management.ts:638 lets the caller pin it; the adapter must honour that.`
  );
  record("deploymentA.packageOnEmptyDeployment", freshDeploymentA.package === undefined || freshDeploymentA.package === null);
  record("deploymentA.infoFromKey", await toNative<storageTypes.DeploymentInfo>(storage.getDeploymentInfo(DEPLOYMENT_KEY_A)));

  // -- 4. three releases ----------------------------------------------------
  // Release 2 carries rollout 50 AND isDisabled -- a disabled package does NOT
  // arm the unfinished-rollout guard (management.ts:891 ends `&& !existingPackage
  // .isDisabled`), so releasing #3 over it is legal by the route's own rules.
  // Two rollout-bearing releases in one history is also the shape that makes the
  // "null out the previous package's rollout on every commit" rule observable at
  // all -- without it, devices OUTSIDE a live rollout stay pinned to a much older
  // bundle, silently, fleet-wide (azure-storage.ts:730-735).
  const committed1 = await toNative<storageTypes.Package>(storage.commitPackage(accountId, appA.id, deploymentAId, makeRelease(1)));
  const committed2 = await toNative<storageTypes.Package>(
    storage.commitPackage(accountId, appA.id, deploymentAId, makeRelease(2, { rollout: 50, isDisabled: true }))
  );
  const committed3 = await toNative<storageTypes.Package>(
    storage.commitPackage(
      accountId,
      appA.id,
      deploymentAId,
      makeRelease(3, {
        rollout: 25,
        isMandatory: true,
        diffPackageMap: { "hash-1": { size: 42, url: "https://blobs.invalid/diff-3-from-1.zip" } },
      })
    )
  );
  record("release.labels", [committed1.label, committed2.label, committed3.label]);

  const historyAfterThree = await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appA.id, deploymentAId));
  record("historyAfterThree", historyAfterThree);
  record(
    "historyAfterThree.fromDeploymentKey",
    await toNative<storageTypes.Package[]>(storage.getPackageHistoryFromDeploymentKey(DEPLOYMENT_KEY_A))
  );

  // getDeployment / getDeployments must hydrate `.package` from the TOP of the
  // history. Three consumers depend on it, one of which is the release guard
  // exercised immediately below.
  const hydratedA = await toNative<storageTypes.Deployment>(storage.getDeployment(accountId, appA.id, deploymentAId));
  record("hydrated.getDeployment.package", hydratedA.package);
  const listedA = await toNative<storageTypes.Deployment[]>(storage.getDeployments(accountId, appA.id));
  const listedDeploymentA = listedA.filter((entry: storageTypes.Deployment) => entry.key === DEPLOYMENT_KEY_A)[0];
  record("hydrated.getDeployments.package", listedDeploymentA && listedDeploymentA.package);

  // -- 5. release over an UNFINISHED ROLLOUT --------------------------------
  // The 409 itself is management.ts's; the fact it is built on is Storage's.
  // Predicate IMPORTED from the route's own module, never retyped, so a change
  // to isUnfinishedRollout cannot drift away from this assertion.
  const existingPackage: storageTypes.Package = hydratedA.package;
  const guardWouldReject: boolean = !!(existingPackage && isUnfinishedRollout(existingPackage.rollout) && !existingPackage.isDisabled);
  record("unfinishedRolloutGuard.rejects", guardWouldReject);
  record("unfinishedRolloutGuard.rolloutSeenByGuard", existingPackage && existingPackage.rollout);

  // -- 6. promote appA/Production -> appB/Production ------------------------
  // Field construction copied from management.ts:1134-1150. The promoted package
  // is committed with rollout 10 so the rollout patch further down has something
  // legal to patch (a completed rollout cannot be patched: management.ts:808).
  const promoteSource: storageTypes.Package = historyAfterThree[historyAfterThree.length - 1];
  const promoted: storageTypes.Package = await toNative<storageTypes.Package>(
    storage.commitPackage(accountId, appB.id, deploymentBId, {
      appVersion: promoteSource.appVersion,
      blobUrl: promoteSource.blobUrl,
      description: promoteSource.description,
      isDisabled: promoteSource.isDisabled,
      isMandatory: promoteSource.isMandatory,
      manifestBlobUrl: promoteSource.manifestBlobUrl,
      packageHash: promoteSource.packageHash,
      rollout: 10,
      size: promoteSource.size,
      uploadTime: BASE_UPLOAD_TIME + 600_000,
      releaseMethod: storageTypes.ReleaseMethod.Promote,
      originalLabel: promoteSource.label,
      originalDeployment: "Production",
    })
  );
  record("promote.committed", promoted);
  record("promote.historyB", await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appB.id, deploymentBId)));

  // -- 7. rollback on appA/Production --------------------------------------
  // management.ts:1200 with no target release: roll back to history[length - 2].
  const historyForRollback = await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appA.id, deploymentAId));
  const rollbackTarget: storageTypes.Package = historyForRollback[historyForRollback.length - 2];
  const rolledBack: storageTypes.Package = await toNative<storageTypes.Package>(
    storage.commitPackage(accountId, appA.id, deploymentAId, {
      appVersion: rollbackTarget.appVersion,
      blobUrl: rollbackTarget.blobUrl,
      description: rollbackTarget.description,
      diffPackageMap: rollbackTarget.diffPackageMap,
      isDisabled: rollbackTarget.isDisabled,
      isMandatory: rollbackTarget.isMandatory,
      manifestBlobUrl: rollbackTarget.manifestBlobUrl,
      packageHash: rollbackTarget.packageHash,
      size: rollbackTarget.size,
      uploadTime: BASE_UPLOAD_TIME + 700_000,
      releaseMethod: storageTypes.ReleaseMethod.Rollback,
      originalLabel: rollbackTarget.label,
    })
  );
  record("rollback.committed", rolledBack);
  record("rollback.targetLabel", rollbackTarget.label);
  const historyAfterRollback = await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appA.id, deploymentAId));
  record("historyAfterRollback", historyAfterRollback);
  record(
    "historyAfterRollback.previousRollouts",
    historyAfterRollback.map((entry: storageTypes.Package) => (entry.rollout === undefined ? null : entry.rollout))
  );

  // -- 8. patch the rollout on appB/Production ------------------------------
  // management.ts:804-830: mutate the entry in the loaded history and hand the
  // WHOLE array back through updatePackageHistory. 100 is stored as null.
  const historyBForPatch = await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appB.id, deploymentBId));
  const packageToPatch: storageTypes.Package = historyBForPatch[historyBForPatch.length - 1];
  assert.ok(
    isUnfinishedRollout(packageToPatch.rollout),
    "sequence bug: the rollout patch step needs a package with an unfinished rollout to patch"
  );
  packageToPatch.rollout = 50;
  packageToPatch.description = "conformance rollout patch";
  await toNative<void>(storage.updatePackageHistory(accountId, appB.id, deploymentBId, historyBForPatch));
  record(
    "patchRollout.historyB",
    await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appB.id, deploymentBId))
  );
  const deploymentBAfterPatch = await toNative<storageTypes.Deployment>(storage.getDeployment(accountId, appB.id, deploymentBId));
  record("patchRollout.hydratedPackage", deploymentBAfterPatch.package);

  // -- 9. id-chain probe ----------------------------------------------------
  // Divergence (4). Read-only on purpose: the write-side equivalents
  // (updateDeployment / commitPackage / removeDeployment through the wrong app)
  // would corrupt the very state the rest of the sequence is asserting on.
  record("idChain.getDeployment", await observeRejection(storage.getDeployment(accountId, appA.id, deploymentBId)));
  record("idChain.getPackageHistory", await observeRejection(storage.getPackageHistory(accountId, appA.id, deploymentBId)));

  // -- 10. clear history ----------------------------------------------------
  await toNative<void>(storage.clearPackageHistory(accountId, appA.id, deploymentAId));
  const clearedHistory = await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appA.id, deploymentAId));
  record("clear.history", clearedHistory);
  const clearedDeployment = await toNative<storageTypes.Deployment>(storage.getDeployment(accountId, appA.id, deploymentAId));
  record("clear.packageRemoved", clearedDeployment.package === undefined || clearedDeployment.package === null);

  // -- 11. two post-clear releases -- the LABEL DIVERGENCE ------------------
  // Everything from here down is recorded with labelTextIsExempt: JsonStorage
  // restarts at v1, the new schema does not. Ordering is still asserted.
  const postClear1 = await toNative<storageTypes.Package>(
    storage.commitPackage(accountId, appA.id, deploymentAId, makeRelease(11, { uploadTime: BASE_UPLOAD_TIME + 800_000 }))
  );
  const postClear2 = await toNative<storageTypes.Package>(
    storage.commitPackage(accountId, appA.id, deploymentAId, makeRelease(12, { uploadTime: BASE_UPLOAD_TIME + 900_000 }))
  );
  record("postClear.labels", [postClear1.label, postClear2.label], /*labelTextIsExempt*/ true);
  record(
    "postClear.history",
    await toNative<storageTypes.Package[]>(storage.getPackageHistory(accountId, appA.id, deploymentAId)),
    /*labelTextIsExempt*/ true
  );
  const deploymentAAfterPostClear = await toNative<storageTypes.Deployment>(storage.getDeployment(accountId, appA.id, deploymentAId));
  record("postClear.hydratedPackage", deploymentAAfterPostClear.package, /*labelTextIsExempt*/ true);

  // -- 12. teardown, which is also a check -------------------------------------
  // removeApp/removeDeployment currently do not AWAIT their deletes
  // (azure-storage.ts submitTransaction at :1360 has no return/await, and
  // removeAllCollaboratorsAppPointers swallows failures via q.allSettled).
  // ON DELETE CASCADE makes the new backend correct for free, but only if the
  // promise is actually awaited -- so read the deployment back afterwards and
  // require a NotFound. A backend that returns before its delete lands shows up
  // here as a resolved read.
  // This is also the only cleanup that exists: `dropAll()` is a deliberate no-op
  // on a real backend (Azure precedent), so without this the Supabase leg leaves
  // two apps and two deployments behind on every run.
  await toNative<void>(storage.removeApp(accountId, appB.id));
  record("teardown.deploymentBGone", await observeRejection(storage.getDeployment(accountId, appB.id, deploymentBId)));
  await toNative<void>(storage.removeApp(accountId, appA.id));
  record("teardown.appsRemaining", (await toNative<storageTypes.App[]>(storage.getApps(accountId))).length);

  await toNative<void>(storage.dropAll());

  return { backend, steps, byStep, aliases };
}

// ---------------------------------------------------------------------------
// PER-BACKEND CHECKS. Run against every leg independently, so that a
// SupabaseStorage bug is caught even when there is no second transcript to diff
// against (which is the normal case: this file runs JsonStorage-only by default,
// and the Supabase leg is what a developer turns on alone while writing it).
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  run: (recording: Recording) => void;
}

function get<T>(recording: Recording, step: string): T {
  const observation = recording.byStep.get(step);
  assert.ok(observation, `the conformance sequence never recorded step ${JSON.stringify(step)}`);
  return observation.value as T;
}

// Asserts an array of packages is ASCENDING and pins its ends. The end-pinning
// is not redundant: a reversed array has identical CONTENTS, so only position
// catches it.
function assertAscendingHistory(history: storageTypes.Package[], expectedHashesInOrder: string[], context: string): void {
  assert.ok(Array.isArray(history), `${context}: package history must be an array, got ${typeof history}`);
  assert.deepStrictEqual(
    history.map((entry: storageTypes.Package) => entry.packageHash),
    expectedHashesInOrder,
    `${context}: package history is not in the expected ORDER. If the contents match but the order does not, the backend is returning DESC -- ` +
      `utils/acquisition.ts:56 walks this array backwards, so every device would be offered the OLDEST enabled package at HTTP 200.`
  );
  assert.strictEqual(history[0].packageHash, expectedHashesInOrder[0], `${context}: history[0] must be the OLDEST release`);
  assert.strictEqual(
    history[history.length - 1].packageHash,
    expectedHashesInOrder[expectedHashesInOrder.length - 1],
    `${context}: history[length - 1] must be the NEWEST release -- commitPackage and the acquisition path both read it as "latest"`
  );

  for (let i = 1; i < history.length; i++) {
    assert.ok(
      labelOrdinal(history[i].label) > labelOrdinal(history[i - 1].label),
      `${context}: label ordinals must strictly increase with array position (index ${i - 1} -> ${i}: ` +
        `${history[i - 1].label} -> ${history[i].label})`
    );
    assert.ok(
      history[i].uploadTime >= history[i - 1].uploadTime,
      `${context}: uploadTime must not go backwards with array position (index ${i - 1} -> ${i})`
    );
  }
}

const PER_BACKEND_CHECKS: Check[] = [
  {
    name: "checkHealth: JsonStorage rejects, a real backend resolves (or /health 500s)",
    run: (recording) => {
      const rejected = get<boolean>(recording, "health.rejected");
      if (recording.backend === "JsonStorage") {
        assert.strictEqual(rejected, true, "JsonStorage.checkHealth is documented to reject; it no longer does");
      } else {
        assert.strictEqual(
          rejected,
          false,
          `${recording.backend}.checkHealth() rejected. The health router chains storage.checkHealth, so /health will 500 ` +
            `and the container will report unhealthy forever (redis-manager.ts had the same trap).`
        );
      }
    },
  },
  {
    name: "deployment key round-trips VERBATIM (an explicit key must never be regenerated)",
    run: (recording) => {
      assert.strictEqual(
        get<string>(recording, "deploymentA.key"),
        DEPLOYMENT_KEY_A,
        "the deployment key came back different from the one supplied. A key is compiled into every shipped binary; " +
          "regenerating one strands every fielded till on that channel forever."
      );
    },
  },
  {
    name: "getDeploymentInfo resolves the key to the right (appId, deploymentId) pair",
    run: (recording) => {
      const info = get<storageTypes.DeploymentInfo>(recording, "deploymentA.infoFromKey");
      assert.strictEqual(recording.aliases[info.appId], "<appA>", "getDeploymentInfo returned the wrong appId for the deployment key");
      assert.strictEqual(
        recording.aliases[info.deploymentId],
        "<deploymentA>",
        "getDeploymentInfo returned the wrong deploymentId for the deployment key"
      );
    },
  },
  {
    name: "a deployment with no releases has no .package",
    run: (recording) => {
      assert.strictEqual(get<boolean>(recording, "deploymentA.packageOnEmptyDeployment"), true);
    },
  },
  {
    name: "commitPackage assigns strictly increasing labels",
    run: (recording) => {
      const labels = get<string[]>(recording, "release.labels");
      assert.strictEqual(labels.length, 3);
      for (let i = 1; i < labels.length; i++) {
        assert.ok(
          labelOrdinal(labels[i]) > labelOrdinal(labels[i - 1]),
          `labels must strictly increase across commits: ${labels[i - 1]} -> ${labels[i]}`
        );
      }
    },
  },
  {
    name: "ARRAY ORDER: getPackageHistory is ASCENDING (oldest first) -- the fleet-downgrade check",
    run: (recording) => {
      assertAscendingHistory(
        get<storageTypes.Package[]>(recording, "historyAfterThree"),
        ["hash-1", "hash-2", "hash-3"],
        "getPackageHistory"
      );
    },
  },
  {
    name: "ARRAY ORDER: getPackageHistoryFromDeploymentKey matches getPackageHistory exactly, index for index",
    run: (recording) => {
      const byIds = get<storageTypes.Package[]>(recording, "historyAfterThree");
      const byKey = get<storageTypes.Package[]>(recording, "historyAfterThree.fromDeploymentKey");
      assertAscendingHistory(byKey, ["hash-1", "hash-2", "hash-3"], "getPackageHistoryFromDeploymentKey");
      assert.deepStrictEqual(
        normalize(byKey, recording.aliases, false),
        normalize(byIds, recording.aliases, false),
        "the key-addressed history differs from the id-addressed one. The ACQUISITION path (every device) uses the key-addressed " +
          "method, so this is the one that decides what the fleet is offered."
      );
    },
  },
  {
    name: "getDeployment hydrates .package with the TOP-of-history package",
    run: (recording) => {
      const history = get<storageTypes.Package[]>(recording, "historyAfterThree");
      const hydrated = get<storageTypes.Package>(recording, "hydrated.getDeployment.package");
      assert.ok(hydrated, "getDeployment returned a deployment with no .package after three releases");
      assert.strictEqual(
        hydrated.packageHash,
        history[history.length - 1].packageHash,
        ".package must be the LAST entry of the history, not the first and not a stale one"
      );
      assert.strictEqual(hydrated.label, history[history.length - 1].label);
      assert.strictEqual(hydrated.rollout, 25, ".package must carry the live rollout -- the release guard reads it off this object");
      assert.strictEqual(hydrated.isMandatory, true, ".package must carry isMandatory");
    },
  },
  {
    name: "getDeployments hydrates .package too (the ERP CodePush page reads the list, not the single get)",
    run: (recording) => {
      const listed = get<storageTypes.Package>(recording, "hydrated.getDeployments.package");
      const single = get<storageTypes.Package>(recording, "hydrated.getDeployment.package");
      assert.ok(listed, "getDeployments returned a deployment with no .package");
      assert.deepStrictEqual(normalize(listed, recording.aliases, false), normalize(single, recording.aliases, false));
    },
  },
  {
    name: "the unfinished-rollout release guard actually REJECTS",
    run: (recording) => {
      assert.strictEqual(
        get<boolean>(recording, "unfinishedRolloutGuard.rolloutSeenByGuard"),
        25,
        "the guard could not see the live rollout value, so it can never fire"
      );
      assert.strictEqual(
        get<boolean>(recording, "unfinishedRolloutGuard.rejects"),
        true,
        "management.ts:891 would have ALLOWED a release over an unfinished rollout. Either .package is not hydrated or its " +
          "rollout/isDisabled did not survive the round trip -- the route's 409 is silently dead."
      );
    },
  },
  {
    name: "promote preserves releaseMethod / originalLabel / originalDeployment and the source blobUrl",
    run: (recording) => {
      const promoted = get<storageTypes.Package>(recording, "promote.committed");
      const sourceHistory = get<storageTypes.Package[]>(recording, "historyAfterThree");
      const source = sourceHistory[sourceHistory.length - 1];
      assert.strictEqual(promoted.releaseMethod, storageTypes.ReleaseMethod.Promote);
      assert.strictEqual(promoted.originalLabel, source.label);
      assert.strictEqual(promoted.originalDeployment, "Production");
      assert.strictEqual(
        promoted.blobUrl,
        source.blobUrl,
        "promote copies blobUrl VERBATIM (management.ts:1139). A backend that rewrites it breaks every already-cached download URL."
      );
      assert.strictEqual(promoted.packageHash, source.packageHash);
      assert.strictEqual(
        labelOrdinal(promoted.label),
        1,
        "a promote into an empty deployment is that deployment's FIRST release and must be labelled v1"
      );
    },
  },
  {
    name: "rollback commits a NEW top-of-history entry that copies the target",
    run: (recording) => {
      const rolledBack = get<storageTypes.Package>(recording, "rollback.committed");
      const targetLabel = get<string>(recording, "rollback.targetLabel");
      const history = get<storageTypes.Package[]>(recording, "historyAfterRollback");
      assert.strictEqual(rolledBack.releaseMethod, storageTypes.ReleaseMethod.Rollback);
      assert.strictEqual(rolledBack.originalLabel, targetLabel);
      assert.strictEqual(rolledBack.packageHash, "hash-2", "rollback with no target rolls back to history[length - 2]");
      assert.strictEqual(history.length, 4, "a rollback APPENDS; it never rewrites or removes history");
      assert.strictEqual(
        history[history.length - 1].packageHash,
        rolledBack.packageHash,
        "the rolled-back package must be the new TAIL of the history array"
      );
      assertAscendingHistory(history, ["hash-1", "hash-2", "hash-3", "hash-2"], "getPackageHistory after rollback");
    },
  },
  {
    name: "every commit NULLS the previous package's rollout (devices outside a rollout must not be pinned to an old bundle)",
    run: (recording) => {
      const rollouts = get<(number | null)[]>(recording, "historyAfterRollback.previousRollouts");
      assert.deepStrictEqual(
        rollouts,
        [null, null, null, null],
        "a superseded package still carries a rollout. getUpdatePackage(..., ignoreRolloutPackages = true) `continue`s past every " +
          "rollout-bearing entry, so devices outside the live rollout silently fall back to a much older bundle -- fleet-wide, " +
          "nothing logged (azure-storage.ts:730-735). It also re-arms management.ts:891 against releases that should be allowed."
      );
    },
  },
  {
    name: "patching a rollout persists on both the history entry and the hydrated .package",
    run: (recording) => {
      const history = get<storageTypes.Package[]>(recording, "patchRollout.historyB");
      const hydrated = get<storageTypes.Package>(recording, "patchRollout.hydratedPackage");
      assert.strictEqual(history.length, 1, "a rollout patch must not add, remove or duplicate history entries");
      assert.strictEqual(history[0].rollout, 50);
      assert.strictEqual(history[0].description, "conformance rollout patch");
      assert.ok(hydrated, "the deployment lost its .package during a rollout patch");
      assert.strictEqual(
        hydrated.rollout,
        50,
        "the patch landed in the history but not on the hydrated .package. The release guard reads .package, so the fleet and " +
          "the guard would disagree about the live rollout."
      );
    },
  },
  {
    name: "ID CHAIN: app A's id must not reach app B's deployment",
    run: (recording) => {
      const probes: { step: string; result: RejectionResult }[] = [
        { step: "idChain.getDeployment", result: get<RejectionResult>(recording, "idChain.getDeployment") },
        { step: "idChain.getPackageHistory", result: get<RejectionResult>(recording, "idChain.getPackageHistory") },
      ];

      if (recording.backend === "JsonStorage") {
        // Divergence (4): pinned, not asserted away. JsonStorage checks only that
        // all three ids EXIST. If this ever flips to "rejected", someone fixed
        // JsonStorage -- delete this branch and let the real assertion apply to
        // every backend.
        probes.forEach((probe) => {
          assert.strictEqual(
            probe.result.rejected,
            false,
            `${probe.step}: JsonStorage is expected to LEAK here (documented divergence 4). It no longer does -- ` +
              `JsonStorage has been fixed, so drop this branch and require every backend to reject.`
          );
        });
        return;
      }

      probes.forEach((probe) => {
        assert.strictEqual(
          probe.result.rejected,
          true,
          `${probe.step}: ${recording.backend} resolved a deployment of app B through app A's id. That is a cross-tenant IDOR ` +
            `(storage.ts:117-119 requires the WHOLE id chain to be verified). The adapter is almost certainly filtering on ` +
            `.eq('id', deploymentId) alone -- migration 803's UNIQUE (app_id, id) exists so it can filter on the PAIR.`
        );
        assert.strictEqual(
          probe.result.code,
          storageTypes.ErrorCode.NotFound,
          `${probe.step}: rejected, but not with ErrorCode.NotFound -- the routes map anything else to a 500 instead of a 404`
        );
      });
    },
  },
  {
    name: "clearPackageHistory empties the history AND removes .package",
    run: (recording) => {
      const cleared = get<storageTypes.Package[]>(recording, "clear.history");
      assert.ok(Array.isArray(cleared), "getPackageHistory must return [] after a clear, never null/undefined");
      assert.strictEqual(cleared.length, 0);
      assert.strictEqual(
        get<boolean>(recording, "clear.packageRemoved"),
        true,
        "the deployment kept a ghost .package after a history clear. Azure does this (Merge mode cannot remove a property); " +
          "JsonStorage and the new schema both delete it, and the ERP CodePush page renders whatever is here as the current release."
      );
    },
  },
  {
    name: "removeApp AWAITS its cascade (a deployment must be unreadable the instant removeApp resolves)",
    run: (recording) => {
      const probe = get<RejectionResult>(recording, "teardown.deploymentBGone");
      assert.strictEqual(
        probe.rejected,
        true,
        "the deployment was still readable after removeApp resolved. Either the delete was not awaited (azure-storage.ts:1360 " +
          "returns before its transaction lands) or the cascade did not reach it."
      );
      assert.strictEqual(
        probe.code,
        storageTypes.ErrorCode.NotFound,
        "a removed deployment must read as NotFound, not as some other error"
      );
      assert.strictEqual(get<number>(recording, "teardown.appsRemaining"), 0, "removeApp left the app pointer behind on the account");
    },
  },
  {
    name: "LABEL DIVERGENCE: after a clear, only ORDERING is asserted -- never label text",
    run: (recording) => {
      const labels = get<string[]>(recording, "postClear.labels");
      assert.strictEqual(labels.length, 2);
      assert.ok(
        labelOrdinal(labels[1]) > labelOrdinal(labels[0]),
        `post-clear labels must strictly increase: ${labels[0]} -> ${labels[1]}`
      );

      // The ONLY per-backend statement about label TEXT after a clear, and it is
      // deliberately one-directional: JsonStorage restarts at v1, everything else
      // is free not to. Do NOT add an assertion that a real backend restarts at
      // v1 -- see divergence (1); the schema's label_counter is monotonic on
      // purpose and codepush_package_deployment_label_uidx forbids reuse.
      if (recording.backend === "JsonStorage") {
        assert.strictEqual(labelOrdinal(labels[0]), 1, "JsonStorage is documented to restart labels at v1 after a clear");
      }

      const history = get<storageTypes.Package[]>(recording, "postClear.history");
      assertAscendingHistory(history, ["hash-11", "hash-12"], "getPackageHistory after clear + two releases");

      const hydrated = get<storageTypes.Package>(recording, "postClear.hydratedPackage");
      assert.ok(hydrated, "the deployment has no .package after two post-clear releases");
      assert.strictEqual(hydrated.label, labels[1], ".package must track the newest post-clear label");
    },
  },
];

// ---------------------------------------------------------------------------
// CROSS-BACKEND CHECK. Only runs when both legs ran.
// ---------------------------------------------------------------------------

// Steps whose EXPECTED value differs per backend by design. Each one is asserted
// by a per-backend check instead; none of them is skipped outright.
const DIFF_EXEMPT_STEPS = new Set<string>([
  "health.rejected", // divergence (3): JsonStorage rejects, a real backend resolves
  "postClear.labels", // divergence (1): label TEXT after a clear; ordering is asserted per backend
  "idChain.getDeployment", // divergence (4): JsonStorage leaks, a real backend must reject
  "idChain.getPackageHistory", // divergence (4)
]);

function compareTranscripts(reference: Recording, candidate: Recording): void {
  assert.deepStrictEqual(
    candidate.steps.map((step) => step.step),
    reference.steps.map((step) => step.step),
    "the two legs did not execute the same sequence -- the transcripts are not comparable"
  );

  reference.steps.forEach((referenceStep, index) => {
    if (DIFF_EXEMPT_STEPS.has(referenceStep.step)) {
      return;
    }

    const candidateStep = candidate.steps[index];
    const exemptLabels = !!referenceStep.labelTextIsExempt;

    assert.deepStrictEqual(
      normalize(candidateStep.value, candidate.aliases, exemptLabels),
      normalize(referenceStep.value, reference.aliases, exemptLabels),
      `step ${JSON.stringify(referenceStep.step)}: ${candidate.backend} disagrees with ${reference.backend}.` +
        (exemptLabels ? "" : " (label text is compared at this step; it is exempt only at and after the history clear)")
    );
  });
}

// ---------------------------------------------------------------------------
// Backend resolution
// ---------------------------------------------------------------------------

const SUPABASE_GATE = "TEST_SUPABASE_STORAGE";
const SUPABASE_MODULE = "../script/storage/supabase-storage";

interface SupabaseLeg {
  enabled: boolean;
  reason: string;
  factory?: StorageFactory;
}

function resolveSupabaseLeg(): SupabaseLeg {
  if (!process.env[SUPABASE_GATE]) {
    return {
      enabled: false,
      reason: `${SUPABASE_GATE} is not set -- Supabase leg skipped (this is the default, and it is not a failure)`,
    };
  }

  // The gate is ON, so from here every failure is a HARD failure. A developer who
  // asked for this leg must not be told "skipped" when the adapter is missing or
  // will not construct.
  let loaded: { SupabaseStorage?: new () => storageTypes.Storage };
  try {
    loaded = require(SUPABASE_MODULE);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `${SUPABASE_GATE} is set but ${SUPABASE_MODULE} could not be loaded: ${message}\n` +
        `Write script/storage/supabase-storage.ts (migration design section C.5) or unset ${SUPABASE_GATE}.`
    );
  }

  const constructor = loaded && loaded.SupabaseStorage;
  if (typeof constructor !== "function") {
    throw new Error(`${SUPABASE_MODULE} does not export a SupabaseStorage class`);
  }

  return { enabled: true, reason: "enabled", factory: () => new constructor() };
}

// ---------------------------------------------------------------------------
// Runners.
//
// The check list is shared: mocha renders it as a describe/it tree when mocha is
// present, and the standalone runner below walks the same array when it is not.
// mocha is NOT a dependency of this fork today (only @types/mocha is), so the
// standalone path is the one that runs; keeping both means adding mocha later
// needs no edit here.
// ---------------------------------------------------------------------------

async function collectRecordings(): Promise<{ json: Recording; supabase?: Recording; skipReason?: string }> {
  const json = await runSequenceGuarded("JsonStorage", () => new JsonStorage(/*disablePersistence*/ true));

  const leg = resolveSupabaseLeg();
  if (!leg.enabled) {
    return { json, skipReason: leg.reason };
  }

  const supabase = await runSequenceGuarded("SupabaseStorage", leg.factory);
  return { json, supabase };
}

const SUITE_NAME = "Storage conformance (JsonStorage vs SupabaseStorage)";

if (typeof describe === "function" && typeof it === "function") {
  describe(SUITE_NAME, () => {
    let recordings: { json: Recording; supabase?: Recording; skipReason?: string };

    before(async () => {
      recordings = await collectRecordings();
      if (recordings.skipReason) {
        console.log(`  [skip] ${recordings.skipReason}`);
      }
    });

    describe("JsonStorage", () => {
      PER_BACKEND_CHECKS.forEach((check) => {
        it(check.name, () => check.run(recordings.json));
      });
    });

    describe("SupabaseStorage", () => {
      PER_BACKEND_CHECKS.forEach((check) => {
        it(check.name, function () {
          if (!recordings.supabase) {
            this.skip();
            return;
          }
          check.run(recordings.supabase);
        });
      });

      it("agrees with JsonStorage step for step", function () {
        if (!recordings.supabase) {
          this.skip();
          return;
        }
        compareTranscripts(recordings.json, recordings.supabase);
      });
    });
  });
} else if (require.main === module) {
  runStandalone().then(
    (failures: number) => process.exit(failures === 0 ? 0 : 1),
    (reason: unknown) => {
      console.error(reason);
      process.exit(1);
    }
  );
}

async function runStandalone(): Promise<number> {
  let failures = 0;

  function report(name: string, run: () => void): void {
    try {
      run();
      console.log(`  ok   ${name}`);
    } catch (reason) {
      failures++;
      const message = reason instanceof Error ? reason.message : String(reason);
      console.log(`  FAIL ${name}`);
      console.log(`       ${message.split("\n").join("\n       ")}`);
    }
  }

  console.log(SUITE_NAME);

  const recordings = await collectRecordings();

  console.log("\n JsonStorage");
  PER_BACKEND_CHECKS.forEach((check) => report(check.name, () => check.run(recordings.json)));

  console.log("\n SupabaseStorage");
  if (!recordings.supabase) {
    console.log(`  skip ${recordings.skipReason}`);
  } else {
    PER_BACKEND_CHECKS.forEach((check) => report(check.name, () => check.run(recordings.supabase)));
    report("agrees with JsonStorage step for step", () => compareTranscripts(recordings.json, recordings.supabase));
  }

  console.log("\n Cache + metrics manager (SupabaseMetricsManager)");
  failures += await runMetricsManagerChecks((line: string) => console.log(line));

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} -- ${failures} failing check(s)`);
  return failures;
}
