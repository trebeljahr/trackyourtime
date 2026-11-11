import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { appleSigning, createNotarizer, notaryCredentials, parseIdentities, pickIdentities } from "./desktop-apple.mjs";

const env = { CSC_LINK: Buffer.from("fake certificate").toString("base64"), CSC_KEY_PASSWORD: "fake certificate password" };

const IDENTITIES = `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Ricos Labs LLC (4BHY8H2J25)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Distribution: Ricos Labs LLC (4BHY8H2J25)"
  3) 0000000000000000000000000000000000000000 "3rd Party Mac Developer Installer: Ricos Labs LLC (4BHY8H2J25)"
     3 valid identities found`;

/** A fake `security` that records every call. */
function fakeSecurity({ failImport = false, identities = IDENTITIES } = {}) {
  const calls = [];
  return {
    calls,
    run: (...args) => {
      calls.push(args);
      if (args[0] === "list-keychains" && args.length === 3) return '"/Users/test/login.keychain-db"\n"/Library/Keychains/System.keychain"';
      if (failImport && args[0] === "import") throw new Error(`import failed with -P ${env.CSC_KEY_PASSWORD}`);
      if (args[0] === "find-identity") return identities;
      return "";
    },
  };
}

describe("identities", () => {
  it("reads the names find-identity prints and picks the one each channel signs with", () => {
    const names = parseIdentities(IDENTITIES);
    assert.equal(names.length, 3);
    assert.deepEqual(pickIdentities(names, { mas: false }), { app: names[0], installer: null });
    assert.deepEqual(pickIdentities(names, { mas: true }), { app: names[1], installer: names[2] });
  });
});

describe("appleSigning", () => {
  it("refuses off macOS and without a certificate, touching no keychain", () => {
    const never = () => assert.fail("must not touch a keychain");
    assert.throws(() => appleSigning(env, { platform: "linux", run: never }), /macOS only/);
    assert.throws(() => appleSigning({}, { platform: "darwin", run: never }), /CSC_LINK/);
  });

  it("unlocks and partitions with the KEYCHAIN's own password, then restores the search list and deletes it", () => {
    const security = fakeSecurity();
    const signing = appleSigning(env, { platform: "darwin", run: security.run });
    assert.equal(signing.identity, "Developer ID Application: Ricos Labs LLC (4BHY8H2J25)");
    assert.equal(signing.installerIdentity, null);
    const create = security.calls.find((c) => c[0] === "create-keychain");
    const partition = security.calls.find((c) => c[0] === "set-key-partition-list");
    // electron-builder ≤ 26.16.0 passed the p12's password here, and macOS 26
    // refused the unlock on every signed build.
    assert.equal(partition[partition.indexOf("-k") + 1], create[2]);
    assert.notEqual(create[2], env.CSC_KEY_PASSWORD);
    assert.ok(existsSync(dirname(signing.keychain)));
    signing.close();
    assert.equal(existsSync(dirname(signing.keychain)), false);
    assert.deepEqual(security.calls.at(-2), ["list-keychains", "-d", "user", "-s", "/Users/test/login.keychain-db", "/Library/Keychains/System.keychain"]);
    assert.deepEqual(security.calls.at(-1), ["delete-keychain", signing.keychain]);
  });

  it("finds the store's two identities in the store certificate", () => {
    const signing = appleSigning(env, { mas: true, platform: "darwin", run: fakeSecurity().run });
    assert.equal(signing.identity, "Apple Distribution: Ricos Labs LLC (4BHY8H2J25)");
    assert.equal(signing.installerIdentity, "3rd Party Mac Developer Installer: Ricos Labs LLC (4BHY8H2J25)");
    signing.close();
  });

  it("cleans up and never shows the password when the import or the identity fails", () => {
    const failing = fakeSecurity({ failImport: true });
    assert.throws(() => appleSigning(env, { platform: "darwin", run: failing.run }), (err) => !err.message.includes(env.CSC_KEY_PASSWORD));
    assert.equal(failing.calls.at(-1)[0], "delete-keychain");
    assert.equal(existsSync(dirname(failing.calls.at(-1)[1])), false);

    const wrong = fakeSecurity({ identities: '  1) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Distribution: X (T)"' });
    assert.throws(() => appleSigning(env, { platform: "darwin", run: wrong.run }), /no Developer ID Application identity/);
    assert.equal(wrong.calls.at(-1)[0], "delete-keychain");
  });
});

describe("notarization", () => {
  it("uses this repo's names for the API key: APPLE_API_KEY is the .p8's path", () => {
    assert.deepEqual(notaryCredentials({ APPLE_API_KEY: "/k/AuthKey_X.p8", APPLE_API_KEY_ID: "X", APPLE_API_ISSUER: "I" }), ["--key", "/k/AuthKey_X.p8", "--key-id", "X", "--issuer", "I"]);
    assert.deepEqual(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: "local" }), ["--keychain-profile", "local"]);
    assert.throws(() => notaryCredentials({ APPLE_API_KEY: "/k" }), /APPLE_API_KEY_ID/);
  });

  const creds = { APPLE_KEYCHAIN_PROFILE: "fake" };

  it("fails on a rejected submission, which notarytool reports with exit code 0, and staples nothing", async () => {
    const calls = [];
    const notarize = createNotarizer({ env: creds, run: (_c, args) => (calls.push(args), '{"status":"Invalid","id":"abc"}'), wait: async () => {} });
    await assert.rejects(notarize("/fake/x.dmg"), /rejected.*notarytool log abc/);
    assert.equal(calls.some((a) => a[0] === "stapler"), false);
  });

  it("submits an app as a zip of itself and staples the app, retrying a slow ticket", async () => {
    const calls = [];
    let stapleFailures = 1;
    const notarize = createNotarizer({
      env: creds,
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "stapler" && args[1] === "staple" && stapleFailures-- > 0) throw new Error("not yet");
        return args[0] === "notarytool" ? '{"status":"Accepted"}' : "";
      },
      wait: async () => {},
    });
    await notarize("/fake/Track Your Time.app", { app: true });
    const submit = calls.find((c) => c[1] === "notarytool");
    assert.match(submit[3], /app\.zip$/);
    assert.deepEqual(calls.at(-1), ["xcrun", "stapler", "validate", "/fake/Track Your Time.app"]);
    assert.ok(calls.some((c) => c[0] === "ditto"));
  });
});
