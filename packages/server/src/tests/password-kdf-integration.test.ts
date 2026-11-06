/**
 * Password unlock against the real better-auth (memory adapter): sign-up with
 * KDF parameters, the update guard, the pre-sign-in answer and the legacy
 * upgrade, including an upgrade cut off between its writes.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { derivePasswordKeys, newPasswordKdf } from "@starter/core";
import {
  canonicalPasswordKdfOnCreate,
  decoyPasswordKdf,
  passwordKdfFor,
  passwordKdfUserFields,
  PasswordUpgradeRefused,
  upgradeToLoginSecret,
  refusesPasswordKdfUpdate,
  type PasswordUpgradeContext,
} from "../auth/password-kdf.js";

const SECRET = "password-kdf-integration-secret-0123456789abcdef";
const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
let context: PasswordUpgradeContext;

before(async () => {
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: SECRET,
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    user: { additionalFields: passwordKdfUserFields },
    databaseHooks: {
      user: {
        create: { before: async (user: Record<string, unknown>) => ({ data: canonicalPasswordKdfOnCreate(user) }) },
        update: { before: async (update: Record<string, unknown>) => (refusesPasswordKdfUpdate(update) ? false : { data: update }) },
      },
    },
  });
  context = (await auth.$context) as PasswordUpgradeContext;
});

const userRow = (email: string) => db.user.find((row) => row.email === email)!;
const hasPassword = (id: string) => db.account.some((row) => row.userId === id && row.providerId === "credential" && row.password);
const answer = (email: string) => { const user = db.user.find((row) => row.email === email) ?? null; return passwordKdfFor(email, user, user ? hasPassword(String(user.id)) : false, SECRET); };
const signIn = (email: string, password: string) => auth.api.signInEmail({ body: { email, password } }).then(() => true, () => false);

describe("password unlock on the server", () => {
  it("stores sign-up parameters canonically and answers them before sign-in", async () => {
    const kdf = newPasswordKdf(), { loginSecret } = await derivePasswordKeys("a typed password", kdf);
    await auth.api.signUpEmail({ body: { email: "new@example.test", password: loginSecret, name: "New", passwordKdf: JSON.stringify({ salt: kdf.salt, iterations: 600000, kdf: "PBKDF2-SHA256", v: 1 }) } });
    assert.equal(userRow("new@example.test").passwordKdf, JSON.stringify(kdf));
    assert.deepEqual(answer("new@example.test"), { state: "ready", kdf });
    assert.equal(await signIn("new@example.test", loginSecret), true);
    assert.equal(await signIn("new@example.test", "a typed password"), false);
  });

  it("drops invalid sign-up parameters and refuses changes through update-user", async () => {
    await auth.api.signUpEmail({ body: { email: "odd@example.test", password: "a typed password", name: "Odd", passwordKdf: "{\"v\":1}" } });
    assert.equal(userRow("odd@example.test").passwordKdf ?? null, null);
    assert.equal(answer("odd@example.test").state, "legacy");
    const before = userRow("new@example.test").passwordKdf;
    const { headers } = await auth.api.signInEmail({ body: { email: "new@example.test", password: (await derivePasswordKeys("a typed password", JSON.parse(String(before)))).loginSecret }, returnHeaders: true });
    const cookie = new Headers({ cookie: String(headers.get("set-cookie")).split(";")[0] });
    await auth.api.updateUser({ body: { name: "Renamed", passwordKdf: JSON.stringify(newPasswordKdf()) }, headers: cookie }).catch(() => undefined);
    assert.equal(userRow("new@example.test").passwordKdf, before);
    await auth.api.updateUser({ body: { name: "Renamed" }, headers: cookie });
    assert.equal(userRow("new@example.test").name, "Renamed");
  });

  it("answers stable decoys for unknown emails", () => {
    const first = answer("Nobody@Example.test"), again = answer("nobody@example.test");
    assert.equal(first.state, "ready");
    assert.deepEqual(first.kdf, again.kdf);
    assert.notEqual(first.kdf.salt, answer("somebody-else@example.test").kdf.salt);
    assert.deepEqual(first.kdf, decoyPasswordKdf("nobody@example.test", SECRET));
  });

  it("upgrades a legacy account from its typed password to the login secret", async () => {
    await auth.api.signUpEmail({ body: { email: "old@example.test", password: "an old password", name: "Old" } });
    assert.equal(answer("old@example.test").state, "legacy");
    const id = String(userRow("old@example.test").id), kdf = newPasswordKdf(), { loginSecret } = await derivePasswordKeys("an old password", kdf);
    await assert.rejects(upgradeToLoginSecret(context, id, { current: "a wrong password", loginSecret, kdf }), (error) => error instanceof PasswordUpgradeRefused && error.reason === "wrong-password");
    await upgradeToLoginSecret(context, id, { current: "an old password", loginSecret, kdf });
    assert.deepEqual(answer("old@example.test"), { state: "ready", kdf });
    assert.equal(await signIn("old@example.test", loginSecret), true);
    assert.equal(await signIn("old@example.test", "an old password"), false);
    // A finished account cannot be re-salted through the upgrade.
    const other = newPasswordKdf();
    await assert.rejects(upgradeToLoginSecret(context, id, { current: loginSecret, loginSecret: (await derivePasswordKeys("an old password", other)).loginSecret, kdf: other }), (error) => error instanceof PasswordUpgradeRefused && error.reason === "kdf-mismatch");
  });

  it("answers pending after a cut-off upgrade, and a retry finishes it", async () => {
    await auth.api.signUpEmail({ body: { email: "cut@example.test", password: "a cut password", name: "Cut" } });
    const id = String(userRow("cut@example.test").id), kdf = newPasswordKdf(), { loginSecret } = await derivePasswordKeys("a cut password", kdf);
    const failing: PasswordUpgradeContext = { ...context, adapter: { ...context.adapter, update: async (args) => { if (args.model === "account") throw new Error("connection lost"); return context.adapter.update(args); } } };
    await assert.rejects(upgradeToLoginSecret(failing, id, { current: "a cut password", loginSecret, kdf }));
    assert.deepEqual(answer("cut@example.test"), { state: "pending", kdf });
    assert.equal(await signIn("cut@example.test", "a cut password"), true);
    await upgradeToLoginSecret(context, id, { current: "a cut password", loginSecret, kdf });
    assert.deepEqual(answer("cut@example.test"), { state: "ready", kdf });
    assert.equal(await signIn("cut@example.test", loginSecret), true);
  });
});
