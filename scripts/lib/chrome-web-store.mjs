/**
 * Chrome Web Store API v2 — the pieces `scripts/chrome-web-store.mjs` runs in
 * `.github/workflows/extension-release.yml`, kept free of process globals so
 * they are unit-tested (`chrome-web-store.test.mjs`) without a network.
 *
 * API reference: https://developer.chrome.com/docs/webstore/api
 * Auth: a service account linked in the Developer Dashboard (Account →
 * Service account), exchanged for an access token with a signed JWT —
 * https://developer.chrome.com/docs/webstore/service-accounts
 *
 * The API updates an existing item only. Creating the item, its store listing,
 * privacy answers and distribution are dashboard work, and a changed
 * visibility has to be published by hand once before `publish` works again.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import { extensionIdFromKey } from "./extension-id.mjs";

export const CWS_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
export const CWS_API = "https://chromewebstore.googleapis.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

// ── Versions ─────────────────────────────────────────────────────────────

/** One to four dot-separated integers, each 0-65535 without leading zeros. */
export const isChromeVersion = (value) =>
  typeof value === "string" &&
  /^\d+(\.\d+){0,3}$/.test(value) &&
  value
    .split(".")
    .every((part) => (part === "0" || !part.startsWith("0")) && Number(part) <= 65535);

/**
 * What a release tag says about the store upload.
 *
 * `v1.2.3` → `{ version: "1.2.3", prerelease: false }`. A prerelease tag keeps
 * its suffix in `release` (the manifest's `version_name`) and is flagged so
 * the workflow can refuse to send it to the store.
 */
export const parseReleaseTag = (tag) => {
  const match = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(String(tag ?? ""));
  if (!match) {
    throw new Error(`"${tag}" is not a vX.Y.Z release tag.`);
  }
  return {
    version: match[1],
    release: `${match[1]}${match[2] ?? ""}`,
    prerelease: match[2] !== undefined,
  };
};

/**
 * Problems with a built manifest against the tag it is released as, as
 * readable lines. Empty means it may be uploaded.
 */
export const manifestVersionProblems = (manifest, tag) => {
  const problems = [];
  let expected;
  try {
    expected = parseReleaseTag(tag);
  } catch (error) {
    return [error.message];
  }
  if (!isChromeVersion(manifest.version)) {
    problems.push(`manifest version "${manifest.version}" is not a Chrome version.`);
  } else if (manifest.version !== expected.version) {
    problems.push(
      `manifest version ${manifest.version} does not match tag ${tag} (expected ${expected.version}). ` +
        `Bump "version" in the root package.json before tagging.`,
    );
  }
  const shown = manifest.version_name ?? manifest.version;
  if (manifest.version === expected.version && shown !== expected.release) {
    problems.push(
      `manifest version_name "${shown}" does not match tag ${tag} (expected ${expected.release}).`,
    );
  }
  return problems;
};

// ── Packaging ────────────────────────────────────────────────────────────

/**
 * The manifest as it goes into the store zip: the same manifest minus `key`.
 *
 * `key` is a PUBLIC key (never the private half), and it is what pins the
 * unpacked production build to the store's id. The store keeps the item's own
 * key, and the v2 docs say nothing about accepting one in an update, so it is
 * left out rather than risking a refused upload. Before it goes, it must name
 * the item being updated — a build carrying a fork's EXTENSION_KEY would
 * otherwise be uploaded over this listing.
 */
export const manifestForUpload = (manifest, itemId) => {
  if (typeof manifest.key === "string" && manifest.key !== "") {
    const id = extensionIdFromKey(manifest.key);
    if (id !== itemId) {
      throw new Error(
        `manifest key belongs to extension ${id}, not store item ${itemId}. ` +
          "Was the build run with EXTENSION_KEY set?",
      );
    }
  }
  const { key: _key, ...rest } = manifest;
  return rest;
};

/** Paths that must never be in the upload, whatever the build emitted. */
export const forbiddenPackagePaths = (paths) =>
  paths.filter((path) => /(^|\/)(key\.pem|[^/]*\.pem|[^/]*\.crx|\.env[^/]*)$/i.test(path));

/** A private key in any file body — checked on every file, not by name only. */
export const containsPrivateKey = (text) =>
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text);

// ── Auth ─────────────────────────────────────────────────────────────────

const base64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Parses the service account JSON key and names what is missing. */
export const parseServiceAccount = (json) => {
  let account;
  try {
    account = JSON.parse(json);
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file).");
  }
  const missing = ["client_email", "private_key"].filter(
    (field) => typeof account?.[field] !== "string" || account[field] === "",
  );
  if (account?.type !== undefined && account.type !== "service_account") {
    throw new Error(
      `CWS_SERVICE_ACCOUNT_JSON has type "${account.type}", expected "service_account".`,
    );
  }
  if (missing.length > 0) {
    throw new Error(`CWS_SERVICE_ACCOUNT_JSON is missing ${missing.join(", ")}.`);
  }
  return {
    clientEmail: account.client_email,
    privateKey: account.private_key,
    tokenUri: account.token_uri || DEFAULT_TOKEN_URI,
  };
};

/** RS256 JWT for Google's jwt-bearer grant, valid for one hour. */
export const serviceAccountAssertion = (account, nowSeconds) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: CWS_SCOPE,
      aud: account.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer
    .sign(account.privateKey)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${claims}.${signature}`;
};

// ── HTTP ─────────────────────────────────────────────────────────────────

/** A readable message out of a Google API error body. */
export const describeApiError = (status, body) => {
  const error = body && typeof body === "object" ? body.error : undefined;
  if (error && typeof error === "object") {
    const parts = [`HTTP ${status}`];
    if (error.status) parts.push(error.status);
    if (error.message) parts.push(error.message);
    const details = Array.isArray(error.details) ? error.details : [];
    for (const detail of details) {
      const text = detail?.reason ?? detail?.description ?? detail?.detail;
      if (text) parts.push(String(text));
      for (const violation of detail?.fieldViolations ?? detail?.violations ?? []) {
        parts.push(`${violation.field ?? violation.subject ?? ""}: ${violation.description ?? ""}`.trim());
      }
    }
    return parts.join(" — ");
  }
  if (typeof body?.error_description === "string") {
    return `HTTP ${status} — ${body.error}: ${body.error_description}`;
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `HTTP ${status}${text ? ` — ${text.slice(0, 500)}` : ""}`;
};

const readBody = async (response) => {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * A client over `fetch`, injectable so tests drive it with a fake.
 * `accessToken` is the bearer token from {@link exchangeServiceAccountToken}.
 */
export const createStoreClient = ({ fetch, accessToken, publisherId, itemId, apiBase = CWS_API }) => {
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const call = async (label, url, init) => {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(`${label} failed: ${describeApiError(response.status, body)}`);
    }
    return body ?? {};
  };
  return {
    upload: (zip) =>
      call("upload", `${apiBase}/upload/v2/${name}:upload`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: zip,
      }),
    fetchStatus: () => call("fetchStatus", `${apiBase}/v2/${name}:fetchStatus`, { method: "GET", headers: {} }),
    publish: (request) =>
      call("publish", `${apiBase}/v2/${name}:publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
  };
};

export const exchangeServiceAccountToken = async ({ fetch, account, nowSeconds }) => {
  const response = await fetch(account.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(account, nowSeconds),
    }).toString(),
  });
  const body = await readBody(response);
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new Error(`service account token exchange failed: ${describeApiError(response.status, body)}`);
  }
  return body.access_token;
};

// ── Upload and publish ───────────────────────────────────────────────────

/**
 * UploadState, without the `UPLOAD_` prefix the prose docs use
 * (`UPLOAD_IN_PROGRESS`) and the enum reference does not (`IN_PROGRESS`).
 */
export const normalizeUploadState = (state) =>
  typeof state === "string" ? state.replace(/^UPLOAD_(?!STATE_)/, "") : "UPLOAD_STATE_UNSPECIFIED";

/** Item states a successful submission may leave the item in. */
export const ACCEPTED_SUBMISSION_STATES = new Set([
  "PENDING_REVIEW",
  "STAGED",
  "PUBLISHED",
  "PUBLISHED_TO_TESTERS",
]);

/**
 * Uploads, then polls `fetchStatus` until the store has processed the package.
 * Resolves with the processed state, throws on FAILED or on timeout.
 */
export const uploadAndWait = async ({
  client,
  zip,
  expectedVersion,
  sleep,
  log = () => {},
  intervalMs = 10_000,
  timeoutMs = 10 * 60_000,
  now = () => Date.now(),
}) => {
  const uploaded = await client.upload(zip);
  let state = normalizeUploadState(uploaded.uploadState);
  log(`upload: ${state}${uploaded.crxVersion ? ` (version ${uploaded.crxVersion})` : ""}`);

  if (uploaded.crxVersion && expectedVersion && uploaded.crxVersion !== expectedVersion) {
    throw new Error(
      `the store read version ${uploaded.crxVersion} from the package, expected ${expectedVersion}.`,
    );
  }

  const deadline = now() + timeoutMs;
  while (state !== "SUCCEEDED") {
    if (state === "FAILED") {
      throw new Error("upload FAILED — the store refused the package. Check the Developer Dashboard for the reason.");
    }
    if (now() >= deadline) {
      throw new Error(`upload still ${state} after ${Math.round(timeoutMs / 1000)}s.`);
    }
    await sleep(intervalMs);
    const status = await client.fetchStatus();
    state = normalizeUploadState(status.lastAsyncUploadState);
    log(`fetchStatus: lastAsyncUploadState ${state}`);
    // NOT_FOUND / unspecified right after an upload is the async record not
    // being visible yet; it keeps polling until the deadline says otherwise.
  }
  return state;
};

/**
 * The `publish` request body. `deployPercentage` is sent only when asked for:
 * unset, the store uses the dashboard's value, and a partial rollout is only
 * available to items with 10,000+ seven-day active users.
 */
export const publishRequest = ({ deployPercentage, staged = false } = {}) => {
  const request = { publishType: staged ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH" };
  if (deployPercentage !== undefined && deployPercentage !== null && deployPercentage !== "") {
    const value = Number(deployPercentage);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`deploy percentage must be an integer from 0 to 100, got "${deployPercentage}".`);
    }
    request.deployInfos = [{ deployPercentage: value }];
  }
  return request;
};

/** Submits for review and checks the state the store answers with. */
export const submit = async ({ client, request, log = () => {}, warn = () => {} }) => {
  const result = await client.publish(request);
  for (const warning of result.warningInfo?.warnings ?? []) {
    warn(`${warning.reason ?? "warning"}: ${warning.description ?? ""}`);
  }
  log(`publish: ${result.state ?? "no state"}`);
  if (!ACCEPTED_SUBMISSION_STATES.has(result.state)) {
    throw new Error(`publish answered state ${result.state ?? "(none)"}, not a submitted state.`);
  }
  return result;
};

/** The `fetchStatus` answer as lines for the job log. */
export const describeItemStatus = (status) => {
  const revision = (label, value) => {
    if (!value) return `${label}: none`;
    const channels = (value.distributionChannels ?? [])
      .map((channel) => `${channel.crxVersion ?? "?"} at ${channel.deployPercentage ?? "?"}%`)
      .join(", ");
    return `${label}: ${value.state ?? "?"}${channels ? ` (${channels})` : ""}`;
  };
  return [
    `item: ${status.itemId ?? status.name ?? "?"}`,
    revision("published", status.publishedItemRevisionStatus),
    revision("submitted", status.submittedItemRevisionStatus),
    `last upload: ${normalizeUploadState(status.lastAsyncUploadState)}`,
    `taken down: ${status.takenDown === true}, warned: ${status.warned === true}`,
  ];
};

/**
 * `STORE_EXTENSION_ID` out of `packages/shared/src/store-clients.ts`, so the
 * workflow uploads to the id the servers trust without a second copy of it.
 */
export const readStoreExtensionId = (path) => {
  const source = readFileSync(path, "utf8");
  const match = /export const STORE_EXTENSION_ID\s*=\s*"([a-p]{32})"/.exec(source);
  if (!match) throw new Error(`STORE_EXTENSION_ID not found in ${path}.`);
  return match[1];
};
