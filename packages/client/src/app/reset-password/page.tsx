"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-error-message";
import { AuthHeader } from "@/components/auth-header";
import { PasswordInput } from "@/components/ui/password-input";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const t = useT("shell");

  // better-auth checks the emailed link before it sends the user here, and
  // lands an expired or used one on `?error=INVALID_TOKEN` with no token.
  // Saying so up front beats a form that can only ever be refused.
  const landedExpired = searchParams.get("error") === "INVALID_TOKEN";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(() =>
    landedExpired ? translate("shell")("auth.reset.expired") : "",
  );
  const [expired, setExpired] = useState(landedExpired);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setExpired(false);

    if (newPassword !== confirmPassword) {
      setError(translate("shell")("auth.passwordsDoNotMatch"));
      return;
    }

    setLoading(true);

    try {
      // better-auth's client resolves a refusal as `{ error }` rather than
      // throwing, so an expired token has to be read off the result — the
      // catch below only ever sees a request that never got an answer.
      const result = await authClient.resetPassword({ newPassword, token });
      if (result.error) {
        setError(authErrorMessage(result.error, "reset"));
        setExpired(result.error.code === "INVALID_TOKEN");
        return;
      }
      router.push("/login");
    } catch {
      setError(translate("shell")("auth.reset.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div
          className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          data-testid="reset-error"
        >
          {error}
          {expired && (
            <>
              {" "}
              <Link
                href="/forgot-password"
                className="font-medium underline"
                data-testid="reset-request-new"
              >
                {t("auth.reset.requestNew")}
              </Link>
            </>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="newPassword" className="text-sm font-medium">
          {t("auth.newPassword")}
        </label>
        <PasswordInput
          id="newPassword"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          data-testid="reset-new-password"
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
          data-testid="reset-confirm-password"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="reset-submit"
      >
        {loading ? t("auth.reset.submitting") : t("auth.reset.submit")}
      </button>
    </form>
  );
}

function LoadingFallback() {
  const tc = useT("common");
  return <p className="text-muted-foreground">{tc("status.loading")}</p>;
}

export default function ResetPasswordPage() {
  const t = useT("shell");
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <AuthHeader title={t("auth.reset.title")} subtitle={t("auth.reset.subtitle")} />
        <Suspense fallback={<LoadingFallback />}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
