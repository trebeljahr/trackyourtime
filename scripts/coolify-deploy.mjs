#!/usr/bin/env node
/**
 * Pin, deploy, gate and — when the gate fails — roll back the hosted apps in
 * Coolify.
 *
 *   node scripts/coolify-deploy.mjs deploy --sha <sha> [--which both|client|server]
 *        [--rollback] [--guard-server-downgrade] [--force-server]
 *   node scripts/coolify-deploy.mjs verify --sha <sha>
 *
 * `deploy` is the split layout (two Coolify apps): build-and-deploy.yml runs
 * it with `--rollback` on every push to main, hosted-rollback.yml runs it by
 * hand with `--guard-server-downgrade` and adds `--rollback` only when
 * `restore_on_failure` is set (the images pinned before a manual rollback are
 * usually the build being escaped). `verify` is the gate alone, for the
 * single-app and webhook layouts, which have no image variable to pin.
 *
 * Environment: COOLIFY_BASE_URL, COOLIFY_API_TOKEN,
 * COOLIFY_SERVER_RESOURCE_UUID, COOLIFY_CLIENT_RESOURCE_UUID (deploy only),
 * IMAGE_OWNER_REPO (deploy only), WEB_URL, API_URL.
 *
 * With no Coolify configured the command prints a ::notice:: and exits 0, as
 * extension-release.yml does without its store secrets; with half of what a
 * command needs it fails, because half a deploy is worse than none.
 *
 * The migration check reads the registry at two commits with git, so the
 * checkout needs the history (`fetch-depth: 0`). Logic and tests:
 * scripts/lib/coolify-deploy.mjs, scripts/lib/coolify-deploy.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { deployWithRollback, parseWhich, verifyOnly } from "./lib/coolify-deploy.mjs";
import { readMigrationContract } from "./lib/release-policy.mjs";

const inActions = process.env.GITHUB_ACTIONS === "true";
const error = (message) => console.error(inActions ? `::error::${message.replace(/\n/g, "%0A")}` : `ERROR: ${message}`);
const notice = (message) => console.log(inActions ? `::notice::${message}` : message);

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const haveCommit = (sha) => {
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

const contracts = new Map();

/**
 * The migration registry at a commit, fetching it once if a shallow or stale
 * checkout lacks it. Throws when it still cannot be read; the caller treats
 * that as "not safe to downgrade". Only the migrations are read: the full
 * `readContract` also throws when an unrelated constant (API_LEVEL, the two
 * floors) changed shape, which would keep the server on a failed build for a
 * reason that has nothing to do with the database.
 */
const contractAt = (sha) => {
  const cached = contracts.get(sha);
  if (cached) return cached;
  if (!haveCommit(sha)) {
    try {
      git("fetch", "--no-tags", "--quiet", "origin", sha);
    } catch {
      // Reported below as a missing commit.
    }
    if (!haveCommit(sha)) throw new Error(`commit ${sha} is not in this checkout`);
  }
  const contract = readMigrationContract(
    (path) => {
      try {
        return git("show", `${sha}:${path}`);
      } catch {
        return null;
      }
    },
    (dir) => {
      try {
        return git("ls-tree", "--name-only", `${sha}:${dir}`).split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  );
  contracts.set(sha, contract);
  return contract;
};

const deps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  contractAt,
};

const env = (name) => (process.env[name] ?? "").trim();

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      sha: { type: "string" },
      which: { type: "string", default: "both" },
      rollback: { type: "boolean", default: false },
      "guard-server-downgrade": { type: "boolean", default: false },
      "force-server": { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  const sha = (values.sha ?? "").trim().toLowerCase();
  if ((command !== "deploy" && command !== "verify") || sha === "") {
    error("usage: node scripts/coolify-deploy.mjs deploy|verify --sha <sha> [--which both|client|server] [--rollback]");
    return 2;
  }

  const webUrl = env("WEB_URL").replace(/\/+$/, "");
  const apiUrl = env("API_URL").replace(/\/+$/, "");
  if (webUrl === "" || apiUrl === "") {
    error("WEB_URL and API_URL must both be set: they are what the gate checks.");
    return 2;
  }

  if (command === "verify") {
    const result = await verifyOnly(deps, { webUrl, apiUrl }, sha);
    if (result.ok) return 0;
    error(result.errors.join("\n"));
    return 1;
  }

  const apps = parseWhich(values.which);
  const coolifyBaseUrl = env("COOLIFY_BASE_URL").replace(/\/+$/, "");
  const coolifyToken = env("COOLIFY_API_TOKEN");
  const uuids = { server: env("COOLIFY_SERVER_RESOURCE_UUID"), client: env("COOLIFY_CLIENT_RESOURCE_UUID") };
  const needed = [
    ["COOLIFY_BASE_URL", coolifyBaseUrl],
    ["COOLIFY_API_TOKEN", coolifyToken],
    ...apps.map((app) => [`COOLIFY_${app.toUpperCase()}_RESOURCE_UUID`, uuids[app]]),
  ];
  const missing = needed.filter(([, value]) => value === "").map(([name]) => name);
  if (missing.length === needed.length) {
    notice("No Coolify secrets are set — nothing deployed. See docs/deploy.md → One-time setup in Coolify.");
    return 0;
  }
  if (missing.length > 0) {
    error(`${missing.join(", ")} not set, while the other Coolify secrets are. Set all of them or none.`);
    return 1;
  }
  const ownerRepo = env("IMAGE_OWNER_REPO");
  if (ownerRepo === "") {
    error("IMAGE_OWNER_REPO must be set: it names the images to pin.");
    return 2;
  }

  const result = await deployWithRollback(
    deps,
    { coolifyBaseUrl, coolifyToken, uuids, ownerRepo, webUrl, apiUrl },
    {
      targetSha: sha,
      apps,
      rollback: values.rollback,
      guardServerDowngrade: values["guard-server-downgrade"],
      forceServer: values["force-server"],
    },
  );
  if (result.ok) {
    notice(`${apps.join(" and ")} at ${sha} passed the deploy gate.`);
    return 0;
  }
  // One annotation, so the run summary shows the headline — the failed
  // check, the new sha and what was restored — with its details under it.
  error(result.errors.join("\n"));
  return 1;
};

main().then(
  (code) => process.exit(code),
  (caught) => {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  },
);
