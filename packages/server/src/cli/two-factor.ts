/**
 * `admin reset-two-factor`: turn two-factor off for one account whose owner
 * lost both the authenticator and every backup code.
 *
 * A dry run unless `--commit`: the operator sees the account, whether 2FA is
 * on and how many sessions would end before anything changes. With
 * `--commit` it clears the flag, deletes the enrolment (secret and backup
 * codes), every `2fa-…` row naming the user (pending challenges, spent
 * codes, step-up markers and attempt counters) and every trusted browser
 * (`trust-device-…`), and signs the account out
 * everywhere unless `--keep-sessions`: whoever asked for the reset has, by
 * definition, not proved the second factor.
 *
 * Through better-auth's adapter rather than raw collections, so the Mongo
 * adapter turns the id into the `ObjectId` the `twoFactor` collection stores.
 * The same change by hand, for an instance without this build:
 *
 *   db.user.updateOne({ email: "x@example.com" }, { $set: { twoFactorEnabled: false } })
 *   db.twoFactor.deleteMany({ userId: ObjectId("<user id>") })
 *   db.verification.deleteMany({ value: "<user id>", identifier: /^(2fa-|trust-device-)/ })
 *   db.session.deleteMany({ userId: ObjectId("<user id>") })
 */
import { CliError } from "./errors.js";
import type { AdminAuth, AdminAuthContext } from "./accounts.js";

type Row = Record<string, unknown>;

export type TwoFactorResetContext = AdminAuthContext & {
  adapter: AdminAuthContext["adapter"] & {
    deleteMany: (args: { model: string; where: { field: string; value: unknown }[] }) => Promise<unknown>;
    delete: (args: { model: string; where: { field: string; value: unknown }[] }) => Promise<unknown>;
  };
};

export type TwoFactorReset = {
  userId: string;
  email: string;
  /** The flag or an enrolment row was there to clear. */
  wasEnabled: boolean;
  /** Sessions signed out (or that would be, on a dry run). */
  sessions: number;
  /** `2fa-…` verification rows removed (or that would be). */
  pendingRows: number;
  committed: boolean;
};

export async function resetTwoFactor(
  auth: AdminAuth,
  input: { email: string; commit: boolean; keepSessions: boolean },
): Promise<TwoFactorReset> {
  const context = (await auth.$context) as TwoFactorResetContext;
  const found = await context.internalAdapter.findUserByEmail(input.email);
  if (!found) throw new CliError(`no account with the email ${input.email}`);
  const { user } = found;
  const userRow = (await context.internalAdapter.findUserById(user.id)) as Row | null;

  const enrolment = await context.adapter.findMany({
    model: "twoFactor",
    where: [{ field: "userId", value: user.id }],
    limit: 10,
  });
  const pending = (
    await context.adapter.findMany({
      model: "verification",
      where: [{ field: "value", value: user.id }],
      limit: 1000,
    })
  ).filter((row) => /^(2fa-|trust-device-)/.test(String(row.identifier)));
  const sessions = input.keepSessions ? 0 : (await context.internalAdapter.listSessions(user.id)).length;
  const result: TwoFactorReset = {
    userId: user.id,
    email: user.email,
    wasEnabled: userRow?.twoFactorEnabled === true || enrolment.length > 0,
    sessions,
    pendingRows: pending.length,
    committed: input.commit,
  };
  if (!input.commit) return result;

  await context.internalAdapter.updateUser(user.id, { twoFactorEnabled: false });
  await context.adapter.deleteMany({ model: "twoFactor", where: [{ field: "userId", value: user.id }] });
  for (const row of pending) {
    await context.adapter.delete({ model: "verification", where: [{ field: "id", value: row.id }] });
  }
  if (!input.keepSessions) await context.internalAdapter.deleteUserSessions(user.id);
  return result;
}

export function formatTwoFactorReset(reset: TwoFactorReset, keepSessions: boolean): string {
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (!reset.wasEnabled && reset.pendingRows === 0) {
    return `${reset.email} (user ${reset.userId}) has no two-factor authentication to reset.${
      reset.committed && !keepSessions ? ` Signed out ${plural(reset.sessions, "session")}.` : ""
    }\n`;
  }
  const sessions = keepSessions ? "keep every session" : `sign out ${plural(reset.sessions, "session")}`;
  if (!reset.committed) {
    return (
      `Dry run: would turn two-factor authentication off for ${reset.email} (user ${reset.userId}), ` +
      `delete its secret and backup codes and ${plural(reset.pendingRows, "pending row")}, and ${sessions}.\n` +
      "Run again with --commit to do it.\n"
    );
  }
  return (
    `Turned two-factor authentication off for ${reset.email} (user ${reset.userId}): deleted its secret, ` +
    `backup codes and ${plural(reset.pendingRows, "pending row")}, and ${
      keepSessions ? "kept every session" : `signed out ${plural(reset.sessions, "session")}`
    }. The next sign-in needs only the password.\n`
  );
}
