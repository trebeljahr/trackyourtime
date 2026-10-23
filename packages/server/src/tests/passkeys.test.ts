import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactorPlugin } from "../auth/account-security.js";
import { passkeyPlugin } from "../auth/passkeys.js";

const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [], passkey: [], twoFactor: [] };
const auth = betterAuth({
  baseURL: "http://localhost:52381", secret: "passkey-integration-test-secret-0123456789abcdef",
  database: memoryAdapter(db), emailAndPassword: { enabled: true }, plugins: [passkeyPlugin("http://localhost:52381"), twoFactorPlugin()],
});
const req = (path: string, init: RequestInit = {}) => auth.handler(new Request(`http://localhost:52381/api/auth${path}`, init));
describe("passkey enrollment and authentication", () => {
  it("refuses unauthenticated registration and credential enumeration", async () => {
    assert.equal((await req("/passkey/generate-register-options")).status, 401);
    assert.equal((await req("/passkey/list-user-passkeys")).status, 401);
  });
  it("issues independent challenges scoped to the configured relying party", async () => {
    const first = await req("/passkey/generate-authenticate-options");
    const second = await req("/passkey/generate-authenticate-options");
    const a = await first.json() as { rpId: string; userVerification: string; challenge: string; allowCredentials?: unknown[] }, b = await second.json() as { challenge: string };
    assert.equal(first.status, 200);
    assert.equal(a.rpId, "localhost");
    assert.equal(a.userVerification, "required");
    assert.notEqual(a.challenge, b.challenge);
    assert.ok(!("allowCredentials" in a) || a.allowCredentials?.length === 0);
  });
  it("does not issue a session for an unsigned authentication response", async () => {
    const response = await req("/passkey/verify-authentication", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:52381" }, body: JSON.stringify({ response: { id: "fabricated", response: {} } }) });
    assert.ok(response.status >= 400);
    assert.equal(db.session.length, 0);
    assert.equal(response.headers.get("set-auth-token"), null);
  });
});

// A real P-256 WebAuthn assertion exercises the library boundary: accepting a
// valid signature without UV would let a presence-only security key bypass
// the device verification the product promises.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = keyPair.publicKey.export({ format: "jwk" });
const credentialId = randomBytes(32).toString("base64url");
const coseKey = Buffer.concat([Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]), Buffer.from(jwk.x!, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y!, "base64url")]);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest();
const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function assertion(verified: boolean, origin = "http://localhost:52381") {
  const options = await req("/passkey/generate-authenticate-options");
  const { challenge } = await options.json() as { challenge: string };
  const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(1);
  const authenticator = Buffer.concat([sha("localhost"), Buffer.from([verified ? 5 : 1]), counter]);
  const signature = sign("sha256", Buffer.concat([authenticator, sha(client)]), keyPair.privateKey);
  const request = { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:52381", cookie: cookies(options) }, body: JSON.stringify({ response: { id: credentialId, rawId: credentialId, type: "public-key", response: { clientDataJSON: client.toString("base64url"), authenticatorData: authenticator.toString("base64url"), signature: signature.toString("base64url"), userHandle: Buffer.from("passkey-owner").toString("base64url") }, clientExtensionResults: {} } }) };
  return { response: await req("/passkey/verify-authentication", request), request };
}
it("requires verified passkeys even with two-factor enabled, and rejects wrong origins and replay", async () => {
  db.user.push({ id: "passkey-owner", name: "Owner", email: "owner@example.test", emailVerified: true, twoFactorEnabled: true, createdAt: new Date(), updatedAt: new Date() });
  db.passkey.push({ id: "saved-passkey", userId: "passkey-owner", credentialID: credentialId, publicKey: coseKey.toString("base64"), counter: 0, deviceType: "singleDevice", backedUp: false, transports: "internal", createdAt: new Date(), aaguid: "00000000-0000-0000-0000-000000000000" });
  const before = db.session.length;
  assert.ok((await assertion(true, "https://attacker.invalid")).response.status >= 400);
  assert.equal(db.session.length, before);
  assert.ok((await assertion(false)).response.status >= 400);
  assert.equal(db.session.length, before);
  const valid = await assertion(true);
  assert.equal(valid.response.status, 200);
  assert.equal(db.session.length, before + 1);
  const body = await valid.response.json() as { user: { id: string } };
  assert.equal(body.user.id, "passkey-owner");
  assert.ok((await req("/passkey/verify-authentication", valid.request)).status >= 400);
  assert.equal(db.session.length, before + 1);
});
