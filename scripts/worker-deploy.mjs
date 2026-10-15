#!/usr/bin/env node
/**
 * Activate the web app's uploaded Cloudflare Worker version for a commit,
 * gate it, and roll back to the version that served before on failure.
 *
 *   node scripts/worker-deploy.mjs activate --sha <sha> [--rollback]
 *
 * build-and-deploy.yml runs it with `--rollback` after the server half passed
 * its gate; hosted-rollback.yml runs it by hand and adds `--rollback` only
 * when `restore_on_failure` is set. The version must have been uploaded with
 * `wrangler versions upload --tag <sha>` (build-and-deploy.yml, build-client).
 *
 * Environment: CLOUDFLARE_API_TOKEN (the Worker's own Editor token) and
 * CLOUDFLARE_ACCOUNT_ID; WEB_URL and API_URL, which the gate checks. The
 * Worker's name is wrangler.jsonc's. With neither Cloudflare value set the
 * command prints a ::notice:: and exits 0, as a fork without the secrets
 * should; with one of the two it fails.
 *
 * Logic and tests: scripts/lib/worker-deploy.mjs, scripts/lib/worker-deploy.test.mjs.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { activate, readWorkerName } from "./lib/worker-deploy.mjs";

const inActions = process.env.GITHUB_ACTIONS === "true";
const error = (message) => console.error(inActions ? `::error::${message.replace(/\n/g, "%0A")}` : `ERROR: ${message}`);
const notice = (message) => console.log(inActions ? `::notice::${message}` : message);
const env = (name) => (process.env[name] ?? "").trim();

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { sha: { type: "string" }, rollback: { type: "boolean", default: false } },
  });
  const sha = (values.sha ?? "").trim().toLowerCase();
  if (positionals[0] !== "activate" || sha === "") {
    error("usage: node scripts/worker-deploy.mjs activate --sha <sha> [--rollback]");
    return 2;
  }
  const webUrl = env("WEB_URL").replace(/\/+$/, "");
  const apiUrl = env("API_URL").replace(/\/+$/, "");
  if (webUrl === "" || apiUrl === "") {
    error("WEB_URL and API_URL must both be set: they are what the gate checks.");
    return 2;
  }
  const apiToken = env("CLOUDFLARE_API_TOKEN");
  const accountId = env("CLOUDFLARE_ACCOUNT_ID");
  if (apiToken === "" && accountId === "") {
    notice("No Cloudflare secrets are set — the web app was not deployed. See docs/deploy.md → Web app on Cloudflare.");
    return 0;
  }
  if (apiToken === "" || accountId === "") {
    error(`${apiToken === "" ? "CLOUDFLARE_API_TOKEN" : "CLOUDFLARE_ACCOUNT_ID"} is not set, while the other one is. Set both or neither.`);
    return 1;
  }
  const worker = readWorkerName(join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc"));

  const result = await activate(
    {
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
    },
    { accountId, apiToken, worker, webUrl, apiUrl },
    { sha, rollback: values.rollback },
  );
  if (result.ok) {
    notice(`web app at ${sha} is live on the Worker ${worker} and passed the deploy gate.`);
    return 0;
  }
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
