"use client";

import { createContext, useContext, useEffect } from "react";
import {
  getNativeSessionRequestToken,
  hasFreshLoginSession,
  isPasswordLoginPending,
  useSession,
} from "@/lib/auth-client";
import { isTokenShell } from "@/lib/shell";
import { useNativeSession } from "@/hooks/use-native-session";

type AuthContextType = {
  user: { id: string; name: string; email: string; image?: string } | null;
  isLoading: boolean;
  sessionError: unknown;
  isAuthenticated: boolean;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  sessionError: null,
  isAuthenticated: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: session, error, isPending, isRefetching, refetch } = useSession();

  const { token: nativeToken, ready: nativeReady } = useNativeSession();
  const needsNativeValidation = isTokenShell() && nativeReady &&
    nativeToken !== getNativeSessionRequestToken() && !hasFreshLoginSession();

  // Normally the first request waits for storage itself. Only a credential
  // arriving after the hydration deadline (or changing later) needs a refetch.
  useEffect(() => {
    if (!needsNativeValidation || isPending || isRefetching || isPasswordLoginPending()) return;
    void refetch();
  }, [needsNativeValidation, nativeToken, isPending, isRefetching, refetch]);

  const value: AuthContextType = {
    user: session?.user
      ? {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? undefined,
        }
      : null,
    isLoading: isPending || (isTokenShell() && !nativeReady) || needsNativeValidation,
    sessionError: error,
    isAuthenticated: !!session?.user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
