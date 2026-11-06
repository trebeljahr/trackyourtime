/**
 * Password unlock (docs/private-workspace-protocol.md → "Password unlock").
 *
 * Clients turn the typed password into a login secret and a key-wrapping key
 * on the device (`derivePasswordKeys` in core). The server never sees the
 * password itself, so it must hand out the per-account KDF parameters before
 * sign-in. They live on the user row as `passwordKdf` (canonical JSON).
 *
 * States, as answered by `passwordKdfFor`:
 * - `ready`   the stored password is the login secret. Clients send only the
 *             derived value.
 * - `legacy`  an account from before password unlock: the stored password is
 *             the typed one. The client signs in with it once and upgrades.
 * - `pending` an upgrade was cut off between its writes. The stored password
 *             may be either form, so the client tries the typed password and
 *             then the derived one, and re-runs the upgrade.
 *
 * Unknown emails (and accounts without a password) answer `ready` with
 * parameters derived from the server secret and the email, so the answer does
 * not reveal whether an account exists. A legacy or pending answer does
 * reveal it; that window closes once the few existing accounts have upgraded.
 */
import { createHmac } from "node:crypto";
import { passwordKdfSchema, type PasswordKdfParams } from "@starter/shared";

export type PasswordKdfState = "ready" | "legacy" | "pending";
export type PasswordKdfAnswer = { state: PasswordKdfState; kdf: PasswordKdfParams };

export const PASSWORD_KDF_FIELD = "passwordKdf";
export const PASSWORD_KDF_PENDING_FIELD = "passwordKdfPending";

/** better-auth `user.additionalFields`. Settable in the sign-up body only. */
export const passwordKdfUserFields = {
  [PASSWORD_KDF_FIELD]: { type: "string", required: false, input: true },
  [PASSWORD_KDF_PENDING_FIELD]: { type: "boolean", required: false, input: false },
} as const;

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Parse a stored or submitted value. Anything else is treated as absent. */
export function parsePasswordKdf(value: unknown): PasswordKdfParams | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed = passwordKdfSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializePasswordKdf(kdf: PasswordKdfParams): string {
  const parsed = passwordKdfSchema.parse(kdf);
  return JSON.stringify({ v: parsed.v, kdf: parsed.kdf, iterations: parsed.iterations, salt: parsed.salt });
}

/** Stable, secret-keyed parameters for an email that has no real ones. */
export function decoyPasswordKdf(email: string, secret: string): PasswordKdfParams {
  const salt = createHmac("sha256", secret).update(`trackyourtime-password-kdf-decoy-v1\0${normalizeLoginEmail(email)}`).digest().subarray(0, 16);
  return { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: base64url(salt) };
}

export type KdfUserRow = { [PASSWORD_KDF_FIELD]?: unknown; [PASSWORD_KDF_PENDING_FIELD]?: unknown };

/**
 * `user` is the row for the email (or null), `hasPassword` whether it has a
 * credential account. A stored-but-invalid value is treated like legacy, so a
 * damaged row can still sign in with the typed password and repair itself.
 */
export function passwordKdfFor(email: string, user: KdfUserRow | null, hasPassword: boolean, secret: string): PasswordKdfAnswer {
  if (!user || !hasPassword) return { state: "ready", kdf: decoyPasswordKdf(email, secret) };
  const kdf = parsePasswordKdf(user[PASSWORD_KDF_FIELD]);
  if (!kdf) return { state: "legacy", kdf: decoyPasswordKdf(email, secret) };
  return { state: user[PASSWORD_KDF_PENDING_FIELD] === true ? "pending" : "ready", kdf };
}

/**
 * `databaseHooks.user.create.before`: keep a valid submitted value in
 * canonical form, drop anything else (the account then signs up as legacy and
 * upgrades on its first sign-in), and never accept a pending flag from input.
 */
export function canonicalPasswordKdfOnCreate<T extends Record<string, unknown>>(user: T): T {
  // better-auth merges hook output over its input, so a dropped value is
  // written as null rather than deleted.
  const kdf = parsePasswordKdf(user[PASSWORD_KDF_FIELD]);
  return { ...user, [PASSWORD_KDF_FIELD]: kdf ? serializePasswordKdf(kdf) : null, [PASSWORD_KDF_PENDING_FIELD]: null } as T;
}

/**
 * `databaseHooks.user.update.before`: the parameters never change through
 * better-auth's own endpoints (`update-user` accepts input fields). A changed
 * salt would make the stored login secret unreachable. better-auth merges a
 * hook's data over its input, so the field cannot be stripped; an update that
 * carries it is refused whole (`false`). The upgrade writes through the raw
 * adapter, which runs no hooks.
 */
export function refusesPasswordKdfUpdate(update: Record<string, unknown>): boolean {
  return PASSWORD_KDF_FIELD in update || PASSWORD_KDF_PENDING_FIELD in update;
}

/** The slice of better-auth's `AuthContext` the upgrade needs. */
export type PasswordUpgradeContext = {
  adapter: {
    findOne<T>(args: { model: string; where: { field: string; value: unknown }[] }): Promise<T | null>;
    update<T>(args: { model: string; where: { field: string; value: unknown }[]; update: Record<string, unknown> }): Promise<T | null>;
  };
  internalAdapter: { findAccounts(userId: string): Promise<{ id: string; providerId: string; password?: string | null }[]> };
  password: { hash(password: string): Promise<string>; verify(data: { hash: string; password: string }): Promise<boolean> };
};

/** `LOGIN_SECRET_PREFIX` + 32 bytes base64url, as `derivePasswordKeys` writes it. */
export const LOGIN_SECRET_PATTERN = /^tyt1\.[A-Za-z0-9_-]{43}$/;

export class PasswordUpgradeRefused extends Error {
  constructor(readonly reason: "no-password" | "wrong-password" | "kdf-mismatch") { super(reason); }
}

/**
 * Switch a signed-in account from its typed password to the derived login
 * secret. `current` may be either form: a retry after a cut-off upgrade
 * already has the login secret stored. Writes, in an order where every cut-off
 * leaves a state `passwordKdfFor` answers as `pending`:
 *   1. user: parameters + pending flag,
 *   2. credential account: hash of the login secret,
 *   3. user: pending flag cleared.
 * A ready account with different parameters refuses: changing the salt of a
 * finished account is a password change, not an upgrade.
 */
export async function upgradeToLoginSecret(
  context: PasswordUpgradeContext,
  userId: string,
  input: { current: string; loginSecret: string; kdf: PasswordKdfParams },
): Promise<void> {
  const kdf = passwordKdfSchema.parse(input.kdf);
  if (!LOGIN_SECRET_PATTERN.test(input.loginSecret)) throw new PasswordUpgradeRefused("wrong-password");
  const user = await context.adapter.findOne<KdfUserRow>({ model: "user", where: [{ field: "id", value: userId }] });
  const credential = (await context.internalAdapter.findAccounts(userId)).find((account) => account.providerId === "credential" && account.password);
  if (!user || !credential?.password) throw new PasswordUpgradeRefused("no-password");
  if (!(await context.password.verify({ hash: credential.password, password: input.current }))) throw new PasswordUpgradeRefused("wrong-password");
  const stored = parsePasswordKdf(user[PASSWORD_KDF_FIELD]);
  if (stored && serializePasswordKdf(stored) !== serializePasswordKdf(kdf)) {
    if (user[PASSWORD_KDF_PENDING_FIELD] !== true) throw new PasswordUpgradeRefused("kdf-mismatch");
  }
  const where = [{ field: "id", value: userId }];
  await context.adapter.update({ model: "user", where, update: { [PASSWORD_KDF_FIELD]: serializePasswordKdf(kdf), [PASSWORD_KDF_PENDING_FIELD]: true } });
  await context.adapter.update({ model: "account", where: [{ field: "id", value: credential.id }], update: { password: await context.password.hash(input.loginSecret) } });
  await context.adapter.update({ model: "user", where, update: { [PASSWORD_KDF_PENDING_FIELD]: false } });
}
