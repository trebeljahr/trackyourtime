"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  signUp,
  getSession,
  POST_AUTH_REDIRECT,
  webCallbackUrl,
} from "@/lib/auth-client";
import { AuthHeader } from "@/components/auth-header";
import { NativeServerNote } from "@/components/server-picker";
import { PasswordInput } from "@/components/ui/password-input";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { authPageHref, safeNextFromSearch } from "@/lib/safe-next";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";
import { authErrorMessage } from "@/lib/auth-error-message";

export default function SignupPage() {
  const router = useRouter();
  const t = useT("shell");
  const tc = useT("common");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifyEmail, setVerifyEmail] = useState(false);
  // `?next=` and `?email=` from an invitation link. Read in an effect: the
  // page is prerendered in Node, where there is no query string to read.
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    const search = window.location.search;
    setNext(safeNextFromSearch(search));
    const prefill = new URLSearchParams(search).get("email");
    if (prefill) setEmail((current) => (current === "" ? prefill : current));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(translate("shell")("auth.passwordsDoNotMatch"));
      return;
    }

    setLoading(true);

    try {
      const result = await signUp.email({
        name,
        email,
        password,
        // Where the verification link lands, when this server requires one.
        // Carries `next`, so an invitee who must verify first still comes
        // back to the invitation after following the link and signing in.
        callbackURL: webCallbackUrl(authPageHref("login", { next })),
      });
      if (result.error) {
        setError(authErrorMessage(result.error, "signup"));
      } else if (result.data && result.data.token === null) {
        // The server requires email verification: the account exists, but no
        // session was created until the link is followed.
        setVerifyEmail(true);
      } else {
        // Populate the session store before navigating, or the protected
        // layout reads an empty session and redirects back to /login.
        await getSession();
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

  if (verifyEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="mx-auto w-full max-w-sm space-y-6" data-testid="signup-verify-email">
          <AuthHeader
            title={t("auth.signup.verifyTitle")}
            subtitle={t("auth.signup.verifySubtitle", { email })}
          />
          <div className="text-center text-sm">
            <Link
              href={authPageHref("login", { next, email })}
              className="text-primary hover:underline"
              data-testid="signup-verify-to-login"
            >
              {t("auth.signup.goToLogin")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <AuthHeader title={t("auth.signup.title")} subtitle={t("auth.signup.subtitle")} />

        {/* Renders nothing on web. */}
        <NativeServerNote />

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="signup-error">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="name" className="text-sm font-medium">
              {tc("fields.name")}
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="signup-name"
            />
          </div>

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
              data-testid="signup-email"
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
              minLength={8}
              data-testid="signup-password"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="text-sm font-medium">
              {t("auth.confirmPassword")}
            </label>
            <PasswordInput
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              data-testid="signup-confirm-password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="signup-submit"
          >
            {loading ? t("auth.signup.submitting") : t("auth.signup.submit")}
          </button>
        </form>

        <GoogleSignInButton />

        <div className="text-center text-sm text-muted-foreground">
          {t.rich("auth.signup.haveAccount", {
            link: (chunks) => (
              <Link
                href={authPageHref("login", { next, email: email || null })}
                className="text-primary hover:underline"
                data-testid="signup-to-login"
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
