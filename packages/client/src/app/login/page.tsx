"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  authClient,
  signIn,
  getSession,
  isTwoFactorChallenge,
  POST_AUTH_REDIRECT,
  webCallbackUrl,
} from "@/lib/auth-client";
import { AuthHeader } from "@/components/auth-header";
import { NativeServerPicker } from "@/components/server-picker";
import { PasswordInput } from "@/components/ui/password-input";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { BrowserSignIn } from "@/components/browser-sign-in";
import {
  TwoFactorChallenge,
  type ChallengeOutcome,
} from "@/components/two-factor-challenge";
import { isElectron, isTokenShell } from "@/lib/shell";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";
import { authErrorMessage } from "@/lib/auth-error-message";
import {
  consumeSessionRevokedNotice,
  type SessionRevokedNotice,
} from "@/lib/session-revoked";
import { authPageHref, safeNextFromSearch } from "@/lib/safe-next";

export default function LoginPage() {
  const router = useRouter();
  const t = useT("shell");
  const tc = useT("common");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"password" | "two-factor">("password");
  // `?next=` (validated by lib/safe-next.ts) and `?email=`, both read in an
  // effect for the same prerender reason as the revoked notice below. The
  // invite page sends people here with both; the protected layout with next.
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    const search = window.location.search;
    setNext(safeNextFromSearch(search));
    const prefill = new URLSearchParams(search).get("email");
    if (prefill) setEmail((current) => (current === "" ? prefill : current));
  }, []);

  /*
   * "Why am I looking at a login screen?"
   *
   * A device signed out from Settings → Devices lands here without having
   * touched anything, so the screen has to answer that question itself — a
   * toast fired during the redirect is gone in four seconds, and on a phone it
   * may have been in a pocket at the time.
   *
   * Read in an effect, never during render: every page is prerendered in Node
   * under `output: "export"`, and a notice that exists only in the browser
   * would make the first client render disagree with the served HTML.
   */
  const [revoked, setRevoked] = useState<SessionRevokedNotice | null>(null);
  useEffect(() => {
    setRevoked(consumeSessionRevokedNotice());
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // No `callbackURL` here, ever: sign-in answers with `{ url, redirect:
      // true }` when one is sent, and better-auth's client then reloads the
      // browser onto that URL instead of letting this page navigate.
      const result = await signIn.email({ email, password });
      if (result.error?.code === "EMAIL_NOT_VERIFIED") {
        // A fresh link, pointed at the web app rather than the API origin.
        await authClient
          .sendVerificationEmail({
            email,
            // Back to this page with its `next`, so an invitee who has to
            // verify first still ends up on the invitation.
            callbackURL: webCallbackUrl(
              authPageHref("login", {
                next: safeNextFromSearch(window.location.search),
              }),
            ),
          })
          .catch(() => undefined);
        setError(translate("shell")("auth.login.emailNotVerified"));
      } else if (result.error) {
        setError(authErrorMessage(result.error, "login"));
      } else if (isTwoFactorChallenge(result.data)) {
        // No session exists yet, and no token was issued.
        if (isTokenShell()) {
          // The challenge is a cookie a WKWebView — or the desktop app, which
          // never sends one — cannot send to the API, so the step could never
          // succeed there; saying so beats a code field that always answers
          // "invalid". The desktop app has a way through: the browser.
          setError(
            translate("shell")(
              isElectron()
                ? "auth.twoFactor.desktopUseBrowser"
                : "auth.twoFactor.nativeUnsupported",
            ),
          );
        } else {
          setStep("two-factor");
        }
      } else {
        // See the note in signup: refresh the session before navigating.
        await getSession();
        // Re-read at submit time rather than trusting state, so a submit that
        // beats the effect still honours the link it arrived with.
        router.replace(
          safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT,
        );
      }
    } catch {
      setError(translate("common")("errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  /** The desktop app's browser sign-in stored a token; finish like the form does. */
  async function handleBrowserSignIn() {
    await getSession();
    router.replace(
      safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT,
    );
  }

  async function handleChallenge(outcome: ChallengeOutcome) {
    if (outcome === "expired") {
      setStep("password");
      setPassword("");
      setError(translate("shell")("auth.login.challengeExpired"));
      return;
    }
    await getSession();
    router.replace(
      safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT,
    );
  }

  if (step === "two-factor") {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="mx-auto w-full max-w-sm space-y-6">
          <AuthHeader
            title={t("auth.twoFactor.title")}
            subtitle={t("auth.twoFactor.signingInAs", { email })}
          />
          <TwoFactorChallenge
            onDone={handleChallenge}
            onCancel={() => {
              setStep("password");
              setPassword("");
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <AuthHeader title={t("auth.login.title")} subtitle={t("auth.login.subtitle")} />

        {/* Renders nothing on web — the web app has no server to choose. */}
        <NativeServerPicker />

        {revoked && (
          <div
            className="rounded-md border border-border bg-muted/50 p-3 text-sm"
            data-testid="login-revoked"
            role="status"
          >
            <p className="font-medium">{t("auth.revoked.title")}</p>
            <p className="text-muted-foreground">
              {revoked.pending > 0
                ? t("auth.revoked.pending", { count: revoked.pending })
                : t("auth.revoked.none")}
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="login-error">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              {tc("fields.email")}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="login-email"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              {tc("fields.password")}
            </label>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid="login-password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="login-submit"
          >
            {loading ? t("auth.login.submitting") : t("auth.login.submit")}
          </button>
        </form>

        {/* Renders nothing outside the desktop app. */}
        <BrowserSignIn onSignedIn={handleBrowserSignIn} />

        <GoogleSignInButton />

        <div className="text-center text-sm">
          <Link href="/forgot-password" className="text-primary hover:underline">
            {t("auth.login.forgotPassword")}
          </Link>
        </div>

        <div className="text-center text-sm text-muted-foreground">
          {t.rich("auth.login.noAccount", {
            link: (chunks) => (
              <Link
                href={authPageHref("signup", { next, email: email || null })}
                className="text-primary hover:underline"
                data-testid="login-to-signup"
              >
                {chunks}
              </Link>
            ),
          })}
        </div>
      </div>
    </div>
  );
}
