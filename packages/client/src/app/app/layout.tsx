"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { getSession, hasFreshLoginSession } from "@/lib/auth-client";
import { useNativeSession } from "@/hooks/use-native-session";
import { verdictForRejection, verdictForResult } from "@/lib/session-verdict";
import { StartupScreen } from "@/components/startup-screen";
import { isTokenShell } from "@/lib/shell";
import { AppShell } from "@/components/app-shell";
import { loginRedirectHref } from "@/lib/safe-next";

type Verdict = "checking" | "in" | "out";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isAuthenticated, isLoading, sessionError } = useAuth();
  // Native hydration includes the bearer token and selected API origin.
  const { token: nativeToken, ready: sessionReady } = useNativeSession();

  // Web confirms cached cookie sessions with the server. Native session
  // requests already bypass the cookie cache, so share that first verdict.
  const [recheck, setRecheck] = React.useState<Verdict>("checking");

  React.useEffect(() => {
    if (!sessionReady) return;
    // A fresh native install has no bearer token. No network request is needed
    // to know it must sign in; do not wait behind two session round trips.
    const signedOutNative =
      isTokenShell() && nativeToken === null && !isAuthenticated;
    if (isLoading && !signedOutNative) return;

    let cancelled = false;
    // Decide after mount so prerendered HTML and hydration both start checking.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecheck(signedOutNative ? "out" : isAuthenticated ? "in" : "checking");
    if (signedOutNative) return;
    if (isTokenShell()) {
      setRecheck(verdictForResult({
        data: isAuthenticated ? { session: true } : null,
        error: sessionError,
      }, { hasStoredToken: nativeToken !== null }));
      return;
    }
    // The password response was just validated by the server in this document.
    if (isAuthenticated && hasFreshLoginSession()) return;

    // `hasStoredToken` is false on web by construction — `getNativeToken()`
    // only ever returns a value under Capacitor. `hasSession` is the web's
    // equivalent evidence, and keeps a signed-in user inside when the check
    // below cannot reach the server at all.
    const context = {
      hasStoredToken: nativeToken !== null,
      hasSession: isAuthenticated,
    };

    void getSession({ query: { disableCookieCache: true } })
      .then((result) => {
        if (cancelled) return;
        setRecheck(verdictForResult(result, context));
      })
      .catch(() => {
        if (cancelled) return;
        setRecheck(verdictForRejection(context));
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, sessionReady, nativeToken, sessionError]);

  React.useEffect(() => {
    if (recheck === "out") router.replace(loginRedirectHref(window.location));
  }, [recheck, router]);

  if (recheck === "out") return null;

  if (isLoading || !sessionReady || recheck === "checking") {
    return <StartupScreen />;
  }

  return <AppShell>{children}</AppShell>;
}
