#!/usr/bin/env node
/**
 * Retire the Coolify side of https://trackyourtime.dev after its move to the
 * Cloudflare Worker trackyourtime-client (cutover 2026-10-18,
 * docs/deploy.md → Web app on Cloudflare).
 *
 *   node scripts/ops/retire-coolify-client.mjs --dry-run     checks and the plan only
 *   node scripts/ops/retire-coolify-client.mjs               checks, plan, "Type DELETE", delete, verify
 *   node scripts/ops/retire-coolify-client.mjs --skip-soak   allow a run before 2026-10-25
 *
 * Deletes, each only after its guard: the no-Worker route
 * trackyourtime.dev/.well-known/acme-challenge/*, the Coolify client apps
 * (the Docker Image app and the stopped legacy Compose app; volumes kept) and
 * their backup sources, the GHCR package trackyourtime-client, and the four
 * COOLIFY_CLIENT_* secrets. Never the API server, its database, the Coolify
 * project, DNS, the self-host image or the COOLIFY_SERVER_* secrets.
 *
 * Run it in an interactive terminal: it reads hatchkit's Coolify and
 * Cloudflare tokens from the keychain through hatchkit's own modules (found
 * from the `hatchkit` binary, or HATCHKIT_DIST), and hatchkit refuses without
 * a TTY unless HATCHKIT_KEYCHAIN_ACCESS=allow. GitHub goes through `gh`
 * (deleting the package needs the `delete:packages` scope:
 * `gh auth refresh -s delete:packages`). Logic and tests:
 * scripts/lib/retire-coolify-client.mjs.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { PACKAGE, REPO, retire } from "../lib/retire-coolify-client.mjs";

const hatchkitDist = () => {
  if (process.env.HATCHKIT_DIST) return resolve(process.env.HATCHKIT_DIST);
  const binary = execFileSync("which", ["hatchkit"], { encoding: "utf8" }).trim();
  return dirname(realpathSync(binary));
};
const load = async (dist, path) => import(pathToFileURL(join(dist, path)).href);

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ghFound = (args) => {
  try {
    gh(args);
    return true;
  } catch (caught) {
    const text = `${caught.stderr ?? ""}${caught.stdout ?? ""}`;
    if (/HTTP 404|Not Found/i.test(text)) return false;
    throw new Error(text.trim() || String(caught));
  }
};
const packagePath = `/user/packages/container/${PACKAGE}`;

const main = async () => {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false }, "skip-soak": { type: "boolean", default: false } },
  });

  const dist = hatchkitDist();
  const config = await load(dist, "config.js");
  const { CoolifyApi } = await load(dist, "utils/coolify-api.js");
  const { CloudflareApi } = await load(dist, "utils/cloudflare-api.js");
  const { ghSecretDelete } = await load(dist, "deploy/gh-actions-secrets.js");
  const { reconcileBackupsAfterRemoval } = await load(dist, "backups/sources.js");

  const coolifyConfig = await config.getCoolifyConfig();
  if (!coolifyConfig) throw new Error("hatchkit has no Coolify configuration (hatchkit config add coolify)");
  const provisioner = await config.getCloudflareProvisioner();
  if (!provisioner) throw new Error("hatchkit has no Cloudflare provisioner (hatchkit config add cloudflare-workers)");

  const result = await retire(
    {
      coolify: new CoolifyApi({ url: coolifyConfig.url, token: coolifyConfig.token }),
      cloudflare: new CloudflareApi({ token: provisioner.token, accountId: provisioner.accountId }),
      github: {
        listSecrets: async () => {
          try {
            return gh(["secret", "list", "-R", REPO, "--json", "name", "-q", ".[].name"]).split("\n").filter(Boolean);
          } catch {
            return null;
          }
        },
        deleteSecret: (name) => ghSecretDelete(REPO, name),
        packageExists: async () => ghFound(["api", packagePath]),
        deletePackage: async () => {
          gh(["api", "-X", "DELETE", packagePath]);
        },
      },
      fetch: (url) => fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
      mainSha: () => gh(["api", `repos/${REPO}/commits/main`, "-q", ".sha"]),
      reconcileBackups: async (uuids) => (await reconcileBackupsAfterRemoval({ uuids, dryRun: false, settleMs: 30_000 })).lines,
      confirm: async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("\nType DELETE to delete the items above: ");
        rl.close();
        return answer.trim() === "DELETE";
      },
      now: () => new Date(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      log: (line) => console.log(`  ${line}`),
    },
    { dryRun: values["dry-run"], skipSoak: values["skip-soak"] },
  );

  if (!result.ok) {
    for (const refusal of result.refusals) console.error(`  REFUSED: ${refusal}`);
    if (result.done.length > 0) console.error(`  Already done: ${result.done.join("; ")}`);
    return 1;
  }
  if (values["dry-run"]) {
    console.log("\n  --dry-run: nothing deleted.");
    return 0;
  }
  if (result.done.length > 0) {
    console.log("\n  Retired. Left for an agent: the repo cleanup in the vault's");
    console.log("  projects/trackyourtime/1-tracktime-manual-notes.md → Web app on Cloudflare Workers.");
  }
  return 0;
};

main().then(
  (code) => process.exit(code),
  (caught) => {
    console.error(`  ERROR: ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exit(1);
  },
);
