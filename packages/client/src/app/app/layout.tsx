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
  const { isAuthenticated, isLoading } = useAuth();
  // On native the bearer token comes out of the Keychain asynchronously, so
  // the very first `useSession()` at the root fires without it and resolves
  // null. Deciding on that would bounce a signed-in phone to /login on every
  // cold launch, so the check waits for `ready` — which is true from the
  // first render on web, where there is no token to wait for.
  const { token: nativeToken, ready: sessionReady } = useNativeSession();

  // The session hook is not the authority, in either direction.
  //
  // A `null` it cached while the user sat on /login or /signup survives the
  // navigation that follows a successful sign-in, so trusting that would
  // bounce a freshly authenticated user straight back to /login. And a
  // session it DID resolve can be a ghost: better-auth answers
  // `/get-session` out of its five-minute cookie cache, so a browser whose
  // account was deleted — or whose session was revoked — on another device
  // keeps being told it is signed in, and keeps rendering the app, for as
  // long as that cache is warm.
  //
  // So confirm with the server once per load, with the cookie cache off, and
  // let only a clean "no session" sign anyone out. A session already in hand
  // renders the app straight away, so the common case shows no loading
  // screen and the check can only ever take a user out.
  const [recheck, setRecheck] = React.useState<Verdict>("checking");

  React.useEffect(() => {
    if (!sessionReady) return;
    // A fresh native install has no bearer token. No network request is needed
    // to know it must sign in; do not wait behind two session round trips.
    const signedOutNative =
      isTokenShell() && nativeToken === null && !isAuthenticated;
    if (isLoading && !signedOutNative) return;

    let cancelled = false;
    // The verdict is decided after mount, never during render: see the
    // `recheck` note above — neither a cached `null` nor a cached session is
    // the authority, so the state starts at "checking" in the prerendered
    // HTML and in the hydrating render, and only an answer moves it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecheck(signedOutNative ? "out" : isAuthenticated ? "in" : "checking");
    if (signedOutNative) return;
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
  }, [isAuthenticated, isLoading, sessionReady, nativeToken]);

  React.useEffect(() => {
    if (recheck === "out") router.replace(loginRedirectHref(window.location));
  }, [recheck, router]);

  if (recheck === "out") return null;

  if (isLoading || !sessionReady || recheck === "checking") {
    return <StartupScreen />;
  }

  return <AppShell>{children}</AppShell>;
}
