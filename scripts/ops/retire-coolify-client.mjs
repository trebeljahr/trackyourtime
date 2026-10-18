#!/usr/bin/env node
/**
 * Retire the hosted Coolify client app after the soak of the move to the
 * Cloudflare Worker (docs/deploy.md → Web app on Cloudflare).
 *
 *   HATCHKIT_KEYCHAIN_ACCESS=allow node scripts/ops/retire-coolify-client.mjs            # audit, read-only
 *   HATCHKIT_KEYCHAIN_ACCESS=allow node scripts/ops/retire-coolify-client.mjs --execute  # retire
 *
 * Deletes, in order: the Coolify app `trackyourtime-client` (volumes kept)
 * and its backup sources, the no-Worker route
 * `trackyourtime.dev/.well-known/acme-challenge/*`, and the four
 * COOLIFY_CLIENT_* repo secrets. Refuses, with nothing changed, before
 * 2026-10-25 (`--early` overrides that one check), while the site is not the
 * Worker's, or when the app routes anything but trackyourtime.dev.
 *
 * Owner-only: it borrows hatchkit's Coolify and Cloudflare provisioner
 * credentials from the macOS keychain (hence HATCHKIT_KEYCHAIN_ACCESS, which
 * hatchkit itself checks) through hatchkit's own modules, found from the
 * `hatchkit` binary or HATCHKIT_DIST. GitHub goes through `gh`. Logic and
 * tests: scripts/lib/retire-coolify-client.mjs.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { retire, SOAK_ENDS } from "../lib/retire-coolify-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const hatchkitDist = () => {
  if (process.env.HATCHKIT_DIST) return resolve(process.env.HATCHKIT_DIST);
  const binary = execFileSync("which", ["hatchkit"], { encoding: "utf8" }).trim();
  return dirname(realpathSync(binary));
};

const load = async (dist, path) => import(pathToFileURL(join(dist, path)).href);

const main = async () => {
  const { values } = parseArgs({
    options: { execute: { type: "boolean", default: false }, early: { type: "boolean", default: false } },
  });
  if (process.env.HATCHKIT_KEYCHAIN_ACCESS !== "allow") {
    console.error("Set HATCHKIT_KEYCHAIN_ACCESS=allow for this run: it reads hatchkit's Coolify and Cloudflare credentials from the keychain.");
    return 2;
  }

  const dist = hatchkitDist();
  const config = await load(dist, "config.js");
  const { CoolifyApi } = await load(dist, "utils/coolify-api.js");
  const { CloudflareApi } = await load(dist, "utils/cloudflare-api.js");
  const { ghSecretDelete, listRepoSecrets } = await load(dist, "deploy/gh-actions-secrets.js");
  const { reconcileBackupsAfterRemoval } = await load(dist, "backups/sources.js");

  const coolifyConfig = await config.getCoolifyConfig();
  if (!coolifyConfig) throw new Error("hatchkit has no Coolify configuration (hatchkit config)");
  const provisioner = await config.getCloudflareProvisioner();
  if (!provisioner) throw new Error("hatchkit has no Cloudflare provisioner (hatchkit config add cloudflare-workers)");

  // Read-only: is the served commit on origin/main?
  execFileSync("git", ["-C", ROOT, "fetch", "--quiet", "origin", "main"], { stdio: "ignore" });
  const onMain = (sha) => {
    try {
      execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", sha, "origin/main"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  const result = await retire(
    {
      coolify: new CoolifyApi({ url: coolifyConfig.url, token: coolifyConfig.token }),
      cloudflare: new CloudflareApi({ token: provisioner.token, accountId: provisioner.accountId }),
      github: { listSecrets: listRepoSecrets, deleteSecret: ghSecretDelete },
      fetch: (url) => fetch(url, { signal: AbortSignal.timeout(15_000) }),
      onMain,
      reconcileBackups: async (uuids) => (await reconcileBackupsAfterRemoval({ uuids, dryRun: false, settleMs: 30_000 })).lines,
      now: () => new Date(),
      log: (line) => console.log(line),
    },
    { execute: values.execute, early: values.early },
  );

  if (!result.ok) {
    for (const refusal of result.refusals) console.error(`REFUSED: ${refusal}`);
    if (result.done.length > 0) console.error(`Already done: ${result.done.join("; ")}`);
    return 1;
  }
  if (!values.execute) {
    console.log(`\nAudit passed; nothing changed. Run again with --execute to retire${new Date().toISOString().slice(0, 10) < SOAK_ENDS ? " (and --early before " + SOAK_ENDS + ")" : ""}.`);
    return 0;
  }
  console.log("\nRetired. Left by hand: the GHCR package ghcr.io/trebeljahr/trackyourtime-client (keep or delete),");
  console.log("and the repo cleanup in the vault's 1-tracktime-manual-notes.md → Web app on Cloudflare Workers.");
  return 0;
};

main().then(
  (code) => process.exit(code),
  (caught) => {
    console.error(`ERROR: ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exit(1);
  },
);
