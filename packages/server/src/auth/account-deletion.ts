// Deleting an account, wired into better-auth's own `POST /delete-user`.
//
// better-auth already does the parts that are easy to get subtly wrong: it
// resolves the session with the cookie cache disabled (a revoked session
// cannot delete anything), it accepts a bearer token like every other endpoint
// (so the mobile shells, which have no cookie, use the same path as the web),
// it verifies a password when one is sent, and it removes the user, accounts
// and every session afterwards. What it does not know about is tracktime's
// data, which is `beforeDelete`'s job here, and one policy it gets too loose.
//
// That policy: with no password in the body, better-auth deletes on a *fresh*
// session alone — one created in the last 24 hours. A browser session is seven
// days long, so "fresh" is simply "signed in this morning", and a laptop left
// open would be one click from losing everything. So an account that HAS a
// password must send it. An account without one (Google sign-in only) has
// nothing to type, and keeps better-auth's fresh-session rule: sign in again,
// then delete.
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  ACCOUNT_DELETION_PASSWORD_REQUIRED,
} from "@starter/shared";
import {
  deleteAccountData,
  type AccountDeletionReport,
  type DeletionRowStore,
} from "../services/account-deletion/delete-account.js";
import {
  authRowStore,
  routedRowStore,
  type AuthAdapterLike,
} from "../services/account-deletion/stores.js";

type DeletedUser = { id: string; email?: string | null };

type AccountRow = { providerId?: unknown; password?: unknown };

/** The part of better-auth's `AuthContext` this module reads. */
export type DeletionAuthContext = {
  adapter: AuthAdapterLike;
  internalAdapter: {
    findAccounts: (userId: string) => Promise<AccountRow[]>;
  };
};

/**
 * Whether the delete request carried a password, per request.
 *
 * Keyed on the `Request` object because that is the one thing better-auth
 * hands to both ends: the before-hook sees the body, and `beforeDelete` sees
 * the request but not the body. The hook cannot simply check the account
 * itself — user-level hooks run BEFORE the bearer plugin turns
 * `Authorization` into a session cookie, so from there a phone's request has
 * no session at all. A WeakMap, so a request that never reaches
 * `beforeDelete` (wrong password, stale session) leaves nothing behind.
 */
const passwordSent = new WeakMap<Request, boolean>();

/**
 * better-auth `hooks.before`: remember whether `/delete-user` was sent a
 * password. Does nothing on any other path.
 *
 * better-auth verifies that password before `beforeDelete` runs and refuses
 * the request if it is wrong, so "sent" and "correct" are the same thing by
 * the time it is read.
 */
export const recordDeletionPassword = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/delete-user" || !ctx.request) return;
  const password = (ctx.body as { password?: unknown } | undefined)?.password;
  passwordSent.set(ctx.request, typeof password === "string" && password.length > 0);
});

/** True when the account can sign in with a password, so must confirm with one. */
export const hasPasswordAccount = (accounts: readonly AccountRow[]): boolean =>
  accounts.some(
    (account) =>
      account.providerId === "credential" &&
      typeof account.password === "string" &&
      account.password.length > 0,
  );

/**
 * The `user.deleteUser` block for `betterAuth()`.
 *
 * `beforeDelete` refuses a password account that did not send its password,
 * then deletes the data. If the data deletion throws, better-auth stops there
 * and the user row survives, so the person can simply try again — the cascade
 * is idempotent. The user row is removed only after everything it owned.
 *
 * `afterDelete` runs the cascade a second time. A request from another of
 * this person's devices can land between the two (a timer started on the
 * phone recreates a personal workspace through `ensurePersonalWorkspace`),
 * and the second pass is what stops that from outliving the account. Its
 * failure is logged, not thrown — the account is already gone, and an error
 * response would tell the person it was not.
 */
export function accountDeletionOptions(deps: {
  context: () => Promise<DeletionAuthContext>;
  appRows: DeletionRowStore;
  /** Called once the account is gone — drops the person's live sockets. */
  onDeleted?: (user: DeletedUser) => void;
  log?: (message: string, error: unknown) => void;
}): {
  enabled: true;
  beforeDelete: (user: DeletedUser, request?: Request) => Promise<void>;
  afterDelete: (user: DeletedUser, request?: Request) => Promise<void>;
} {
  const cascade = async (user: DeletedUser): Promise<AccountDeletionReport> => {
    const context = await deps.context();
    const rows = routedRowStore(deps.appRows, authRowStore(context.adapter));
    return deleteAccountData(rows, user);
  };
  const log = deps.log ?? ((message, error) => console.error(message, error));

  return {
    enabled: true,
    async beforeDelete(user, request) {
      const context = await deps.context();
      const accounts = await context.internalAdapter.findAccounts(user.id);
      if (hasPasswordAccount(accounts) && !(request && passwordSent.get(request))) {
        throw new APIError("BAD_REQUEST", {
          code: ACCOUNT_DELETION_PASSWORD_REQUIRED,
          message: "Enter your password to delete your account.",
        });
      }
      await cascade(user);
    },
    async afterDelete(user) {
      try {
        await cascade(user);
      } catch (error) {
        log("[auth] account deletion: second cascade pass failed", error);
      }
      deps.onDeleted?.(user);
    },
  };
}
