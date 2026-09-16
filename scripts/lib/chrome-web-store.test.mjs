/**
 * The Chrome Web Store release logic, against a fake `fetch`.
 *
 * Run by the server package's `test` script (`pnpm test:unit`), with the other
 * plain-node script tests in this directory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { STORE_EXTENSION_ID, STORE_EXTENSION_KEY } from "../../packages/shared/src/store-clients.ts";
import {
  CWS_SCOPE,
  containsPrivateKey,
  createStoreClient,
  describeApiError,
  describeItemStatus,
  exchangeServiceAccountToken,
  forbiddenPackagePaths,
  isChromeVersion,
  manifestForUpload,
  manifestVersionProblems,
  normalizeUploadState,
  parseReleaseTag,
  parseServiceAccount,
  publishRequest,
  readStoreExtensionId,
  serviceAccountAssertion,
  submit,
  uploadAndWait,
} from "./chrome-web-store.mjs";

const repoFile = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** A fetch that answers from a queue of `[status, body]` and records calls. */
const fakeFetch = (answers) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    assert.ok(next, `unexpected request to ${url}`);
    const [status, body] = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
};

const client = (answers) => {
  const fake = fakeFetch(answers);
  return {
    ...fake,
    client: createStoreClient({
      fetch: fake.fetch,
      accessToken: "token",
      publisherId: "pub-1",
      itemId: STORE_EXTENSION_ID,
    }),
  };
};

describe("versions", () => {
  it("accepts Chrome versions and nothing else", () => {
    for (const ok of ["1", "0.1.0", "1.2.3.4", "65535.0"]) assert.equal(isChromeVersion(ok), true, ok);
    for (const bad of ["", "v1.0.0", "1.2.3.4.5", "01.0", "1.65536", "1.0-rc.1", undefined]) {
      assert.equal(isChromeVersion(bad), false, String(bad));
    }
  });

  it("parses release tags", () => {
    assert.deepEqual(parseReleaseTag("v1.2.3"), { version: "1.2.3", release: "1.2.3", prerelease: false });
    assert.deepEqual(parseReleaseTag("v0.2.0-rc.1"), {
      version: "0.2.0",
      release: "0.2.0-rc.1",
      prerelease: true,
    });
    assert.throws(() => parseReleaseTag("main"), /not a vX\.Y\.Z/);
    assert.throws(() => parseReleaseTag("1.2.3"), /not a vX\.Y\.Z/);
  });

  it("passes a manifest whose version is the tag", () => {
    assert.deepEqual(manifestVersionProblems({ version: "0.1.0" }, "v0.1.0"), []);
    assert.deepEqual(
      manifestVersionProblems({ version: "0.2.0", version_name: "0.2.0-rc.1" }, "v0.2.0-rc.1"),
      [],
    );
  });

  it("fails a manifest that was not bumped, naming the fix", () => {
    const [problem] = manifestVersionProblems({ version: "0.1.0" }, "v0.2.0");
    assert.match(problem, /0\.1\.0 does not match tag v0\.2\.0/);
    assert.match(problem, /root package\.json/);
  });

  it("fails a version_name that disagrees with a prerelease tag", () => {
    assert.equal(manifestVersionProblems({ version: "0.2.0" }, "v0.2.0-rc.1").length, 1);
    assert.equal(manifestVersionProblems({ version: "0.2.0", version_name: "0.2.0-rc.1" }, "v0.2.0").length, 1);
  });

  it("fails a tag that is not a release tag", () => {
    assert.match(manifestVersionProblems({ version: "0.1.0" }, "main")[0], /not a vX\.Y\.Z/);
  });

  it("matches the extension's own version source, the root package.json", () => {
    const { version } = JSON.parse(readFileSync(repoFile("package.json"), "utf8"));
    const source = readFileSync(repoFile("packages/extension/manifest.config.ts"), "utf8");
    assert.match(source, /rootPackage\.version/);
    assert.equal(isChromeVersion(version.split(/[-+]/)[0]), true);
  });
});

describe("packaging", () => {
  it("drops the store key after checking it pins the item", () => {
    const manifest = { manifest_version: 3, version: "0.1.0", key: STORE_EXTENSION_KEY };
    const uploaded = manifestForUpload(manifest, STORE_EXTENSION_ID);
    assert.equal("key" in uploaded, false);
    assert.equal(uploaded.version, "0.1.0");
    assert.equal(manifest.key, STORE_EXTENSION_KEY, "the input is not mutated");
  });

  it("refuses a build keyed for another extension", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const forkKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    assert.throws(
      () => manifestForUpload({ version: "0.1.0", key: forkKey }, STORE_EXTENSION_ID),
      /not store item opibnndhibnigcfgfbgbipakadhnbjfi.*EXTENSION_KEY/,
    );
  });

  it("passes a manifest with no key unchanged", () => {
    assert.deepEqual(manifestForUpload({ version: "1.0" }, STORE_EXTENSION_ID), { version: "1.0" });
  });

  it("flags key files and private key bodies", () => {
    assert.deepEqual(
      forbiddenPackagePaths(["manifest.json", "key.pem", "icons/16.png", "a/b.PEM", "x.crx", ".env.production"]),
      ["key.pem", "a/b.PEM", "x.crx", ".env.production"],
    );
    assert.equal(containsPrivateKey("-----BEGIN PRIVATE KEY-----\nabc"), true);
    assert.equal(containsPrivateKey("-----BEGIN RSA PRIVATE KEY-----"), true);
    assert.equal(containsPrivateKey(`{"key":"${STORE_EXTENSION_KEY}"}`), false);
  });

  it("reads the item id the servers trust", () => {
    assert.equal(readStoreExtensionId(repoFile("packages/shared/src/store-clients.ts")), STORE_EXTENSION_ID);
  });
});

describe("service account auth", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyJson = JSON.stringify({
    type: "service_account",
    client_email: "cws@project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  });

  it("names what a key file is missing", () => {
    assert.throws(() => parseServiceAccount("nope"), /not valid JSON/);
    assert.throws(() => parseServiceAccount("{}"), /missing client_email, private_key/);
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ type: "authorized_user" })),
      /expected "service_account"/,
    );
  });

  it("signs an RS256 assertion Google can verify", () => {
    const account = parseServiceAccount(keyJson);
    const jwt = serviceAccountAssertion(account, 1_000);
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
      iss: "cws@project.iam.gserviceaccount.com",
      scope: CWS_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_000,
      exp: 4_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
  });

  it("exchanges the assertion for an access token", async () => {
    const { fetch, calls } = fakeFetch([[200, { access_token: "ya29.x", expires_in: 3600 }]]);
    const token = await exchangeServiceAccountToken({ fetch, account: parseServiceAccount(keyJson), nowSeconds: 1 });
    assert.equal(token, "ya29.x");
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(body.get("assertion").split(".").length, 3);
  });

  it("fails loudly when Google refuses the key", async () => {
    const { fetch } = fakeFetch([[400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }]]);
    await assert.rejects(
      exchangeServiceAccountToken({ fetch, account: parseServiceAccount(keyJson), nowSeconds: 1 }),
      /token exchange failed: HTTP 400 — invalid_grant: Invalid JWT Signature\./,
    );
  });
});

describe("upload", () => {
  const noSleep = async () => {};

  it("posts the zip to the v2 upload URL", async () => {
    const { client: store, calls } = client([[200, { uploadState: "SUCCEEDED", crxVersion: "0.1.0" }]]);
    await uploadAndWait({ client: store, zip: Buffer.from("zip"), expectedVersion: "0.1.0", sleep: noSleep });
    assert.equal(
      calls[0].url,
      `https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/${STORE_EXTENSION_ID}:upload`,
    );
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer token");
    assert.equal(calls[0].init.headers["Content-Type"], "application/zip");
  });

  it("polls fetchStatus until an in-progress upload succeeds", async () => {
    const { client: store, calls } = client([
      [200, { uploadState: "UPLOAD_IN_PROGRESS" }],
      [200, { lastAsyncUploadState: "IN_PROGRESS" }],
      [200, { lastAsyncUploadState: "SUCCEEDED" }],
    ]);
    const slept = [];
    const state = await uploadAndWait({
      client: store,
      zip: Buffer.from("zip"),
      sleep: async (ms) => slept.push(ms),
      intervalMs: 5,
    });
    assert.equal(state, "SUCCEEDED");
    assert.deepEqual(slept, [5, 5]);
    assert.match(calls[1].url, /\/v2\/publishers\/pub-1\/items\/[a-p]{32}:fetchStatus$/);
    assert.equal(calls[1].init.method, "GET");
  });

  it("fails on a FAILED upload", async () => {
    const { client: store } = client([
      [200, { uploadState: "IN_PROGRESS" }],
      [200, { lastAsyncUploadState: "FAILED" }],
    ]);
    await assert.rejects(uploadAndWait({ client: store, zip: Buffer.from(""), sleep: noSleep }), /upload FAILED/);
  });

  it("gives up after the timeout", async () => {
    let clock = 0;
    const { client: store } = client([
      [200, { uploadState: "IN_PROGRESS" }],
      [200, { lastAsyncUploadState: "NOT_FOUND" }],
      [200, { lastAsyncUploadState: "IN_PROGRESS" }],
    ]);
    await assert.rejects(
      uploadAndWait({
        client: store,
        zip: Buffer.from(""),
        sleep: async (ms) => {
          clock += ms;
        },
        intervalMs: 50,
        timeoutMs: 100,
        now: () => clock,
      }),
      /still IN_PROGRESS after 0s/,
    );
  });

  it("fails when the store read a different version from the package", async () => {
    const { client: store } = client([[200, { uploadState: "SUCCEEDED", crxVersion: "0.0.9" }]]);
    await assert.rejects(
      uploadAndWait({ client: store, zip: Buffer.from(""), expectedVersion: "0.1.0", sleep: noSleep }),
      /read version 0\.0\.9 .* expected 0\.1\.0/,
    );
  });

  it("surfaces the API's error, e.g. a version that was not bumped", async () => {
    const { client: store } = client([
      [
        400,
        {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "The version must be greater than the published version.",
          },
        },
      ],
    ]);
    await assert.rejects(
      uploadAndWait({ client: store, zip: Buffer.from(""), sleep: noSleep }),
      /upload failed: HTTP 400 — INVALID_ARGUMENT — The version must be greater/,
    );
  });

  it("normalizes both spellings of the upload state", () => {
    assert.equal(normalizeUploadState("UPLOAD_IN_PROGRESS"), "IN_PROGRESS");
    assert.equal(normalizeUploadState("IN_PROGRESS"), "IN_PROGRESS");
    assert.equal(normalizeUploadState("UPLOAD_STATE_UNSPECIFIED"), "UPLOAD_STATE_UNSPECIFIED");
    assert.equal(normalizeUploadState(undefined), "UPLOAD_STATE_UNSPECIFIED");
  });
});

describe("publish", () => {
  it("builds the request, with a percentage only when asked", () => {
    assert.deepEqual(publishRequest(), { publishType: "DEFAULT_PUBLISH" });
    assert.deepEqual(publishRequest({ deployPercentage: "" }), { publishType: "DEFAULT_PUBLISH" });
    assert.deepEqual(publishRequest({ deployPercentage: "25", staged: true }), {
      publishType: "STAGED_PUBLISH",
      deployInfos: [{ deployPercentage: 25 }],
    });
    assert.throws(() => publishRequest({ deployPercentage: "101" }), /0 to 100/);
    assert.throws(() => publishRequest({ deployPercentage: "12.5" }), /0 to 100/);
  });

  it("submits and accepts a pending review, passing warnings on", async () => {
    const { client: store, calls } = client([
      [
        200,
        {
          state: "PENDING_REVIEW",
          warningInfo: { warnings: [{ reason: "PERMISSION", description: "broad host" }] },
        },
      ],
    ]);
    const warnings = [];
    await submit({ client: store, request: publishRequest(), warn: (w) => warnings.push(w) });
    assert.match(calls[0].url, /:publish$/);
    assert.deepEqual(JSON.parse(calls[0].init.body), { publishType: "DEFAULT_PUBLISH" });
    assert.deepEqual(warnings, ["PERMISSION: broad host"]);
  });

  it("fails on a state that is not a submission", async () => {
    const { client: store } = client([[200, { state: "REJECTED" }]]);
    await assert.rejects(submit({ client: store, request: publishRequest() }), /state REJECTED/);
  });

  it("fails on an API error", async () => {
    const { client: store } = client([
      [400, { error: { code: 400, status: "FAILED_PRECONDITION", message: "Item has a pending review." } }],
    ]);
    await assert.rejects(submit({ client: store, request: publishRequest() }), /publish failed: .*pending review/);
  });

  it("describes the item status", () => {
    assert.deepEqual(
      describeItemStatus({
        itemId: STORE_EXTENSION_ID,
        publishedItemRevisionStatus: {
          state: "PUBLISHED",
          distributionChannels: [{ crxVersion: "0.1.0", deployPercentage: 100 }],
        },
        submittedItemRevisionStatus: { state: "PENDING_REVIEW" },
        lastAsyncUploadState: "SUCCEEDED",
      }),
      [
        `item: ${STORE_EXTENSION_ID}`,
        "published: PUBLISHED (0.1.0 at 100%)",
        "submitted: PENDING_REVIEW",
        "last upload: SUCCEEDED",
        "taken down: false, warned: false",
      ],
    );
    assert.equal(describeItemStatus({})[1], "published: none");
  });

  it("formats a non-JSON error body", () => {
    assert.equal(describeApiError(502, "<html>bad gateway</html>"), "HTTP 502 — <html>bad gateway</html>");
    assert.equal(describeApiError(500, null), "HTTP 500 — null");
  });
});
