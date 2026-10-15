/**
 * Activate the web app's uploaded Worker version, gate it, and put the
 * previous version back when the gate fails — the client half of the hosted
 * deploy, run by scripts/worker-deploy.mjs from build-and-deploy.yml (after
 * the server half passed its own gate) and from hosted-rollback.yml.
 *
 * The web app is an assets-only Cloudflare Worker (wrangler.jsonc). CI's
 * build-client job uploads each commit with `wrangler versions upload --tag
 * <sha>`, which serves nothing yet. Activation is a separate deployment that
 * sends 100 % of requests to that version: done in one step with the upload,
 * Cloudflare served the new HTML for a few seconds before its chunks
 * (measured on the hatchkit canary, 2026-10-12).
 *
 * A version keeps its own files, so going back is one more deployment of the
 * previous version, complete and immediate. The server is never touched
 * here: a client that fails after a good server deploy leaves the new server
 * with the old client, which is the compatible direction, and the error says
 * so.
 *
 * Network, clock and logging are injected, so worker-deploy.test.mjs drives
 * the whole sequence against a fake Cloudflare API and a fake site.
 * docs/deploy.md → Web app on Cloudflare.
 */
import { readFileSync } from "node:fs";

import { waitForHealthy } from "./coolify-deploy.mjs";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The annotation `wrangler versions upload --tag` writes. */
export const TAG_ANNOTATION = "workers/tag";

const messageOf = (caught) => (caught instanceof Error ? caught.message : String(caught));

/**
 * The `name` of a wrangler.jsonc. Comments are stripped outside strings only:
 * a URL in a string holds `//` too.
 */
export const workerNameFromConfig = (text) => {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else out += char;
  }
  const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  if (typeof parsed.name !== "string" || parsed.name === "") throw new Error("wrangler.jsonc has no name");
  return parsed.name;
};

export const readWorkerName = (path) => workerNameFromConfig(readFileSync(path, "utf8"));

/**
 * @typedef {object} WorkerConfig
 * @property {string} accountId
 * @property {string} apiToken     never logged
 * @property {string} worker
 * @property {string} webUrl
 * @property {string} apiUrl
 * @property {number} [pollAttempts]
 * @property {number} [pollIntervalMs]
 * @property {number} [gateAttempts]
 * @property {number} [gateIntervalMs]
 */

/** One Cloudflare API call; throws with Cloudflare's own error text. */
const cf = async (deps, config, method, path, body) => {
  const response = await deps.fetch(`${CLOUDFLARE_API}/accounts/${config.accountId}/workers/scripts/${config.worker}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let parsed;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new Error(`Cloudflare answered ${method} ${path} with ${response.status} and no JSON`);
  }
  if (!response.ok || parsed.success === false) {
    const errors = (parsed.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare refused ${method} ${path} (${response.status}${errors ? `, ${errors}` : ""})`);
  }
  return parsed.result;
};

/** Uploaded versions, newest first. Ten pages of 100 reach back months. */
export const listVersions = async (deps, config) => {
  const items = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await cf(deps, config, "GET", `/versions?page=${page}&per_page=100`);
    const batch = result?.items ?? [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
};

/** The newest version uploaded for a commit, or null. */
export const versionForSha = (versions, sha) =>
  versions.find((version) => version?.annotations?.[TAG_ANNOTATION] === sha) ?? null;

/** The commit a version was uploaded for, when it was tagged with one. */
export const shaOfVersion = (versions, versionId) => {
  const tag = versions.find((version) => version.id === versionId)?.annotations?.[TAG_ANNOTATION];
  return typeof tag === "string" && /^[0-9a-f]{40}$/.test(tag) ? tag : null;
};

/**
 * The version serving all traffic now, or null. A split deployment (a gradual
 * rollout someone started by hand) has no single version to return to, and
 * is reported rather than guessed at.
 */
export const activeVersion = async (deps, config) => {
  const result = await cf(deps, config, "GET", "/deployments");
  const latest = result?.deployments?.[0];
  if (!latest) return { versionId: null, detail: "the Worker has no deployment yet" };
  const full = (latest.versions ?? []).filter((version) => version.percentage === 100);
  if (full.length !== 1) return { versionId: null, detail: `deployment ${latest.id} splits traffic between versions` };
  return { versionId: full[0].version_id, detail: null };
};

/** Send 100 % of requests to one version. */
export const deployVersion = async (deps, config, versionId, message) => {
  await cf(deps, config, "POST", "/deployments", {
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: { "workers/message": message.slice(0, 100) },
  });
  deps.log(`deployed Worker version ${versionId} to 100%`);
};

/**
 * Activate the version uploaded for `sha`, gate it, and on a failed gate put
 * the version that served before it back when `rollback` is set.
 *
 * The gate is scripts/lib/coolify-deploy.mjs's, against the live hosts: the
 * client's `/version.json` names `sha` and the API it was built against, the
 * API is healthy, `get-session` answers and the CORS preflight from the web
 * origin passes. The server's commit is not checked here; its own gate ran
 * first.
 *
 * Never loops: a failed rollback is reported and the run fails.
 *
 * @param {{ fetch: Function, sleep: (ms: number) => Promise<void>, log: (line: string) => void }} deps
 * @param {WorkerConfig} config
 * @param {{ sha: string, rollback: boolean }} request
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export const activate = async (deps, config, { sha, rollback }) => {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, errors: [`${sha} is not a full 40-character commit sha`] };
  let versions;
  let previous;
  try {
    versions = await listVersions(deps, config);
    previous = await activeVersion(deps, config);
  } catch (caught) {
    return { ok: false, errors: [`the Worker ${config.worker} could not be read (${messageOf(caught)}); nothing was changed`] };
  }
  const target = versionForSha(versions, sha);
  if (target === null) {
    return { ok: false, errors: [`no version of ${config.worker} was uploaded for ${sha} (tag ${TAG_ANNOTATION}); nothing was changed`] };
  }
  const previousSha = previous.versionId === null ? null : shaOfVersion(versions, previous.versionId);
  deps.log(`client before: ${previous.versionId ?? `<none: ${previous.detail}>`}${previousSha ? ` (${previousSha})` : ""}`);

  const gateConfig = {
    webUrl: config.webUrl,
    apiUrl: config.apiUrl,
    pollAttempts: config.pollAttempts ?? 36,
    pollIntervalMs: config.pollIntervalMs ?? 5_000,
    gateAttempts: config.gateAttempts,
    gateIntervalMs: config.gateIntervalMs,
  };

  let problems;
  try {
    if (previous.versionId === target.id) deps.log(`version ${target.id} already serves all traffic`);
    else await deployVersion(deps, config, target.id, `${sha.slice(0, 12)} from CI`);
    problems = await waitForHealthy(deps, gateConfig, { serverSha: null, clientSha: sha });
  } catch (caught) {
    problems = [`deploy: ${messageOf(caught)}`];
  }
  if (problems.length === 0) return { ok: true, errors: [] };

  const failed = [...new Set(problems.map((problem) => problem.slice(0, problem.indexOf(":"))))].join(", ");
  const details = problems.map((problem) => `  ${problem}`);
  const headline = (outcome) => `the web app at ${sha} failed the deploy gate (${failed}); ${outcome}. The API server keeps whatever build its own step left live.`;
  if (!rollback) return { ok: false, errors: [headline(`version ${target.id} stays live, since no rollback was requested`), ...details] };
  if (previous.versionId === null || previous.versionId === target.id) {
    const why = previous.versionId === null ? previous.detail : "it was already the live version";
    return { ok: false, errors: [headline(`nothing to roll back to (${why}); version ${target.id} stays live`), ...details] };
  }

  const restored = `version ${previous.versionId}${previousSha ? ` (${previousSha})` : ""}`;
  deps.log(`rolling the web app back to ${restored}`);
  try {
    await deployVersion(deps, config, previous.versionId, `rollback from ${sha.slice(0, 12)}`);
  } catch (caught) {
    return { ok: false, errors: [headline(`ROLLBACK to ${restored} FAILED (${messageOf(caught)}); the web app needs a person now`), ...details] };
  }
  const after = await waitForHealthy(deps, gateConfig, { serverSha: null, clientSha: previousSha });
  if (after.length > 0) {
    return {
      ok: false,
      errors: [headline(`ROLLBACK to ${restored} FAILED its own gate; the web app needs a person now`), ...details, ...after.map((p) => `  after rollback: ${p}`)],
    };
  }
  return { ok: false, errors: [headline(`rolled back to ${restored}, which passed the gate`), ...details] };
};
