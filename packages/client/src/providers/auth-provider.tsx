"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { isPasswordLoginPending, useSession } from "@/lib/auth-client";
import { useNativeSession } from "@/hooks/use-native-session";

type AuthContextType = {
  user: { id: string; name: string; email: string; image?: string } | null;
  isLoading: boolean;
  isAuthenticated: boolean;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, refetch } = useSession();

  /*
   * Re-resolve the session store once the Keychain hands over a token.
   *
   * `useSession()` is mounted here, at the root, and better-auth fires its
   * one `/get-session` on mount. On native that is *before* the Keychain read
   * settles, so `fetchOptions.auth.token` in `lib/auth-client.ts` returns
   * undefined, the request goes out with no `Authorization` header, and the
   * store caches `null` — permanently, because nothing else ever refetches
   * it. `ProtectedLayout` papers over the routing half of that with its own
   * `getSession()` recheck, but every consumer of `useAuth().user` (the
   * account screen, the avatar, anything that greets the user by name) stays
   * empty for the life of the launch.
   *
   * On localhost this is invisible: the API is same-site with the dev
   * WebView origin, so the cookie rides along and the tokenless request
   * succeeds anyway. Against the deployed API from `capacitor://localhost` it
   * is cross-site, no cookie is sent, and the store never fills.
   *
   * The ordering below is deliberate:
   *
   *  - `isPending` gates on the *initial* request having settled. Two
   *    `/get-session` calls in flight at once race, and the loser's answer is
   *    whatever lands last — a tokenless `null` clobbering a good session is
   *    exactly the bug this is fixing, so the refetch waits its turn rather
   *    than betting on request ordering.
   *  - `session?.user` means the first pass already resolved (every web
   *    request, and any native launch where the Keychain beat the mount), so
   *    there is nothing to redo.
   *  - the ref makes it at most one refetch per token value, so a token the
   *    server has revoked answers `null` once instead of looping.
   *
   * Web is untouched by construction: `getNativeToken()` only ever returns a
   * value under Capacitor, so `token` is null and the effect returns on its
   * second line.
   */
  const { token: nativeToken, ready: nativeReady } = useNativeSession();
  const resolvedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!nativeReady || !nativeToken || isPasswordLoginPending()) return;
    if (isPending) return;
    if (session?.user) return;
    if (resolvedFor.current === nativeToken) return;

    resolvedFor.current = nativeToken;
    void refetch();
  }, [nativeReady, nativeToken, isPending, session, refetch]);

  const value: AuthContextType = {
    user: session?.user
      ? {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? undefined,
        }
      : null,
    isLoading: isPending,
    isAuthenticated: !!session?.user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
