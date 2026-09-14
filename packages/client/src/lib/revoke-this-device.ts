"use client";

/**
 * The revoked-session handler, wired to this app's real storage.
 *
 * `lib/session-revoked.ts` holds the decisions and takes its collaborators as
 * arguments, so it can be driven without a Keychain, a cookie jar or a
 * router. This module is the one place those arguments are the real thing —
 * which also keeps `hooks/use-sync.ts` from importing better-auth, the toast
 * layer and the offline queue just to answer one close code.
 *
 * `signOut()` is the wrapper from `lib/auth-client`, so both halves of the
 * credential go: better-auth's own session store and cookie on web, and the
 * Keychain item on native (its `finally`, plus the explicit
 * `clearNativeToken` below for the case where the request throws before
 * better-auth gets that far).
 *
 * The offline queue is read and left alone — see `lib/session-revoked.ts` for
 * why those rows outlive the session that made them.
 */

import { toast } from "@/components/ui/sonner";
import { translate } from "@/i18n/translate";
import { authClient, signOut } from "@/lib/auth-client";
import { clearNativeToken } from "@/lib/native-session";
import { refreshPendingCount } from "@/lib/offline";
import { handleSessionRevoked } from "@/lib/session-revoked";

/** The same words the login screen shows on arrival, in the rendered language. */
const description = (pending: number): string => {
  const t = translate("shell");
  return pending > 0
    ? t("auth.revoked.pending", { count: pending })
    : t("auth.revoked.none");
};

/** Sign this device out because the server says its session is gone. */
export const revokeThisDevice = (
  redirect: () => void,
  resume?: () => void,
): Promise<void> =>
  handleSessionRevoked({
    // Asked without the cookie cache, which would answer from the old session.
    stillSignedIn: async () => {
      const { data } = await authClient.getSession({
        query: { disableCookieCache: true },
      });
      return Boolean(data?.session);
    },
    resume,
    pendingCount: refreshPendingCount,
    signOut: () => signOut(),
    clearToken: clearNativeToken,
    notify: ({ pending }) =>
      toast.error(translate("shell")("auth.revoked.title"), {
        description: description(pending),
      }),
    redirect,
  });
