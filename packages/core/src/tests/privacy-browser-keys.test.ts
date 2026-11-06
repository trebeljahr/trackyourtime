import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { browserKeyRequestFromHash, browserKeysUrl, createBrowserKeyReceiver, sealBrowserKeys } from "../privacy/browser-keys.js";
import { sealForRecipient } from "../privacy/crypto.js";
import { startBrowserSignIn } from "../browser-sign-in.js";

const SERVER = "https://api.example.test";

describe("browser sign-in key delivery", () => {
  it("delivers keys sealed by the approving browser, through the fragment only", async () => {
    const receiver = await createBrowserKeyReceiver<{ secret: string }>(SERVER);
    const url = browserKeysUrl("https://app.example.test/app/device/?user_code=ABCD-EFGH", receiver.request);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("user_code"), "ABCD-EFGH");
    assert.equal(parsed.search.includes(receiver.request.secret), false);
    const request = browserKeyRequestFromHash(parsed.hash)!;
    assert.deepEqual(request, receiver.request);
    const box = await sealBrowserKeys(request, "user-1", { secret: "the account keys" });
    assert.deepEqual(await receiver.open("user-1", box), { secret: "the account keys" });
    await assert.rejects(receiver.open("user-1", box), /closed/);
  });

  it("refuses a box the relay made itself, and one sealed for another account", async () => {
    const forged = await createBrowserKeyReceiver(SERVER);
    // The relay knows the public key, but not the pairing secret.
    const box = await sealForRecipient(forged.request.publicKey, { v: 1, value: { secret: "attacker keys" }, pairing: "guess" }, "anything");
    await assert.rejects(forged.open("user-1", box));
    const other = await createBrowserKeyReceiver(SERVER);
    const sealed = await sealBrowserKeys(other.request, "user-2", { secret: "x" });
    await assert.rejects(other.open("user-1", sealed));
  });

  it("answers null for a page without a key request, and refuses an expired one", async () => {
    assert.equal(browserKeyRequestFromHash("#something=else"), null);
    const receiver = await createBrowserKeyReceiver(SERVER);
    const url = browserKeysUrl("https://app.example.test/app/device/", receiver.request);
    assert.throws(() => browserKeyRequestFromHash(new URL(url).hash, () => Date.now() + 10 * 60_000), /expired/);
  });

  it("collects keys after the device token, and none when the browser sent none", async () => {
    const calls: string[] = [];
    let flowRequest: Parameters<typeof sealBrowserKeys>[0] | null = null;
    let box: unknown = null, relayed = true;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path === "/api/auth/device/code") return Response.json({ device_code: "dev", user_code: "ABCD-EFGH", verification_uri: "https://app.example.test/app/device/", verification_uri_complete: "https://app.example.test/app/device/?user_code=ABCD-EFGH", expires_in: 600, interval: 1 });
      if (path === "/api/auth/get-session") { assert.equal(new Headers(init?.headers).get("authorization"), "Bearer tok"); return Response.json({ user: { id: "user-1" } }); }
      if (path === "/api/trpc/privacy.deviceUnlockStatus") {
        if (!relayed) return Response.json({ error: { data: { code: "NOT_FOUND" } } }, { status: 404 });
        if (!box) { box = await sealBrowserKeys(flowRequest!, "user-1", { secret: "keys" }); return Response.json({ result: { data: { box: null } } }); }
        return Response.json({ result: { data: { box } } });
      }
      if (path === "/api/trpc/privacy.cancelDeviceUnlock") return Response.json({ result: { data: null } });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    const options = { baseUrl: SERVER, clientId: "trackyourtime-raycast" as const, fetchImpl };
    const flow = await startBrowserSignIn<{ secret: string }>(options);
    flowRequest = browserKeyRequestFromHash(new URL(flow.url).hash);
    assert.deepEqual(await flow.collectKeys("tok", { sleepImpl: async () => {} }), { userId: "user-1", keys: { secret: "keys" } });
    assert.equal(calls.at(-1), "/api/trpc/privacy.cancelDeviceUnlock");
    relayed = false;
    const none = await startBrowserSignIn(options);
    assert.deepEqual(await none.collectKeys("tok"), { userId: "user-1", keys: null });
  });
});
