// Copyright (c) LazyWait.
//
// One-off admin migration for app ownership on the CodePush server.
//
// Per app it does, IN ORDER (ordering is load-bearing — see below):
//   a. promote each --owners email to Owner   (idempotent; enables multiple owners)
//   b. (the loop covers every owner email)
//   c. if a --remove email is present on the app: demote it to Collaborator
//   d. then remove it from the app entirely
//
// Why this order: the server has a "last-owner guard" that rejects demoting the
// sole Owner of an app. The new owners (a/b) must be in place BEFORE the old owner
// is demoted (c) and removed (d), so the app always has >= 1 Owner and the guard
// never fires on the account we intend to remove.
//
// Everything goes through the running server via the management SDK, so every write
// is subject to the server's permission checks, last-owner guard, and idempotent
// setCollaboratorPermission — it never writes raw storage rows. The access key must
// belong to an account the server treats as authorized for these apps: either an
// Owner of each app, or an account listed in the server's ADMIN_EMAILS break-glass
// allowlist (see api ENVIRONMENT — ADMIN_EMAILS).
//
// Usage (from the `cli` directory, after `npm run build`):
//
//   # dry run (default) — prints the plan, writes nothing
//   node bin/scripts/backfill-owners.js --server <URL> --key <ACCESS_KEY>
//
//   # apply
//   node bin/scripts/backfill-owners.js --server <URL> --key <ACCESS_KEY> --apply
//
// Defaults: promote asad@lazywait.com + saf_523_@hotmail.com to Owner on every app,
// and remove alkhateralaa@outlook.com from any app it is on. Override with:
//   --owners a@b.com,c@d.com     --remove old@owner.com     (--remove "" to skip removal)

import AccountManager = require("../script/management-sdk");
import { App, CollaboratorMap } from "../script/types";

const OWNER: string = "Owner";
const COLLABORATOR: string = "Collaborator";
const DEFAULT_OWNERS: string[] = ["asad@lazywait.com", "saf_523_@hotmail.com"];
const DEFAULT_REMOVE: string = "alkhateralaa@outlook.com";

interface Args {
  serverUrl: string;
  accessKey: string;
  owners: string[];
  remove: string | undefined;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const serverUrl = get("--server") || process.env.CODEPUSH_SERVER_URL;
  const accessKey = get("--key") || process.env.CODEPUSH_ACCESS_KEY;

  const ownersRaw = get("--owners");
  const owners = ownersRaw
    ? ownersRaw
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
    : DEFAULT_OWNERS;

  // --remove is optional; pass --remove "" to disable removal entirely.
  const removeRaw = get("--remove");
  const remove = removeRaw === undefined ? DEFAULT_REMOVE : removeRaw.trim() || undefined;

  const apply = argv.indexOf("--apply") >= 0;

  if (!serverUrl) {
    throw new Error("Missing --server <url> (or CODEPUSH_SERVER_URL env var).");
  }
  if (!accessKey) {
    throw new Error("Missing --key <accessKey> (or CODEPUSH_ACCESS_KEY env var).");
  }

  return {
    serverUrl,
    accessKey,
    owners: owners.map((e) => e.toLowerCase()),
    remove: remove ? remove.toLowerCase() : undefined,
    apply,
  };
}

// The server stores collaborator emails with the account's original casing, and
// write endpoints match the map key case-sensitively. So we look up case-insensitively
// but return the EXACT stored key/permission to feed back into writes.
function findCollaborator(
  collaborators: CollaboratorMap | undefined,
  email: string
): { key: string; permission: string } | undefined {
  if (!collaborators) return undefined;
  const key = Object.keys(collaborators).find((k) => k.toLowerCase() === email.toLowerCase());
  return key ? { key, permission: collaborators[key].permission } : undefined;
}

function statusOf(e: any): number | undefined {
  return e && typeof e.statusCode === "number" ? e.statusCode : undefined;
}

function messageOf(e: any): string {
  return (e && (e.message || e.text)) || String(e);
}

async function migrate(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sdk = new AccountManager(args.accessKey, /*customHeaders*/ undefined, args.serverUrl);

  console.log(`Server:  ${args.serverUrl}`);
  console.log(`Owners:  ${args.owners.join(", ")}`);
  console.log(`Remove:  ${args.remove || "(none)"}`);
  console.log(`Mode:    ${args.apply ? "APPLY (writing changes)" : "DRY RUN (no changes)"}`);
  console.log("");

  const apps: App[] = await sdk.getApps();
  console.log(`Found ${apps.length} app(s).\n`);

  let planned = 0;
  let applied = 0;
  let errors = 0;

  for (const app of apps) {
    // ----- Steps a/b: promote each owner email to Owner -----
    for (const email of args.owners) {
      const current = findCollaborator(app.collaborators, email);

      if (current && current.permission === OWNER) {
        console.log(`  [skip]  ${app.name}: ${email} is already Owner`);
        continue;
      }

      planned++;

      if (!args.apply) {
        const action = current ? `promote ${current.permission} -> Owner` : "add as Owner";
        console.log(`  [plan]  ${app.name}: ${email} (${action})`);
        continue;
      }

      try {
        // If not a collaborator yet, add first (server adds as Collaborator).
        // Tolerate 409 (already a collaborator) for idempotency.
        if (!current) {
          try {
            await sdk.addCollaborator(app.name, email);
          } catch (e: any) {
            if (statusOf(e) !== AccountManager.ERROR_CONFLICT) throw e;
          }
        }
        // Promote to Owner (idempotent server-side when already Owner).
        await sdk.setCollaboratorPermission(app.name, email, OWNER);
        applied++;
        console.log(`  [done]  ${app.name}: ${email} is now Owner`);
      } catch (e: any) {
        errors++;
        console.error(`  [FAIL]  ${app.name}: promote ${email} -> ${messageOf(e)}`);
      }
    }

    // ----- Steps c/d: remove the old owner, only after a/b -----
    if (!args.remove) continue;
    const target = findCollaborator(app.collaborators, args.remove);
    if (!target) continue; // not on this app — nothing to do

    planned++;

    if (!args.apply) {
      console.log(`  [plan]  ${app.name}: remove ${target.key} (demote ${target.permission} -> Collaborator, then remove)`);
      continue;
    }

    try {
      // Step c: demote to Collaborator so removeCollaborator will accept it.
      // Idempotent when already Collaborator. HALT-worthy: a 400 here means the
      // last-owner guard fired => the new owners (a/b) did not persist. We do NOT
      // proceed to removal in that case; surface it loudly.
      try {
        await sdk.setCollaboratorPermission(app.name, target.key, COLLABORATOR);
      } catch (e: any) {
        if (statusOf(e) === AccountManager.ERROR_NOT_FOUND) {
          // Already gone entirely — nothing to remove.
          console.log(`  [skip]  ${app.name}: ${target.key} already absent`);
          continue;
        }
        throw e; // includes the 400 last-owner-guard case
      }

      // Step d: remove entirely. Tolerate 404 (already removed) as success.
      try {
        await sdk.removeCollaborator(app.name, target.key);
      } catch (e: any) {
        if (statusOf(e) !== AccountManager.ERROR_NOT_FOUND) throw e;
      }

      applied++;
      console.log(`  [done]  ${app.name}: removed ${target.key}`);
    } catch (e: any) {
      errors++;
      console.error(`  [FAIL]  ${app.name}: remove ${target.key} -> ${messageOf(e)}`);
    }
  }

  console.log("");
  if (!args.apply) {
    console.log(`Dry run complete. ${planned} change(s) would be made. Re-run with --apply to execute.`);
  } else {
    console.log(`Done. ${applied} change(s) applied, ${errors} error(s).`);
  }

  if (errors > 0) {
    process.exitCode = 1;
  }
}

migrate().catch((err: any) => {
  console.error("Migration failed:", messageOf(err));
  process.exit(1);
});
