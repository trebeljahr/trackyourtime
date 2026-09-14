"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { getSession } from "@/lib/auth-client";
import { useNativeSession } from "@/hooks/use-native-session";
import {
  verdictForRejection,
  verdictForResult,
} from "@/lib/session-verdict";
import { AppShell } from "@/components/app-shell";
import { loginRedirectHref } from "@/lib/safe-next";

type Verdict = "checking" | "in" | "out";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  // On native the bearer token comes out of the Keychain asynchronously, so
  // the very first `useSession()` at the root fires without it and resolves
  // null. Deciding on that would bounce a signed-in phone to /login on every
  // cold launch, so the check waits for `ready` — which is true from the
  // first render on web, where there is no token to wait for.
  const { token: nativeToken, ready: sessionReady } = useNativeSession();

  // The session hook is mounted at the root, so a `null` it cached while the
  // user sat on /login or /signup survives the navigation that follows a
  // successful sign-in. Trusting it directly would bounce a freshly
  // authenticated user straight back to /login. Before redirecting anyone,
  // confirm with the server once.
  const [recheck, setRecheck] = React.useState<Verdict>("checking");

  React.useEffect(() => {
    if (isLoading || !sessionReady) return;

    if (isAuthenticated) {
      setRecheck("in");
      return;
    }

    let cancelled = false;
    setRecheck("checking");

    // `hasStoredToken` is false on web by construction — `getNativeToken()`
    // only ever returns a value under Capacitor — so the web verdict is
    // exactly what it was: session or /login.
    const context = { hasStoredToken: nativeToken !== null };

    void getSession()
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
  }, [isAuthenticated, isLoading, sessionReady, nativeToken]);

  React.useEffect(() => {
    if (recheck === "out") router.replace(loginRedirectHref(window.location));
  }, [recheck, router]);

  if (isLoading || !sessionReady || recheck === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (recheck === "out") return null;

  return <AppShell>{children}</AppShell>;
}
