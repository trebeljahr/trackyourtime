"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthHeader } from "@/components/auth-header";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";
import { requestPasswordReset } from "@/lib/password-reset";

export default function ForgotPasswordPage() {
  const t = useT("shell");
  const tc = useT("common");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch {
      setError(translate("common")("errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <AuthHeader title={t("auth.forgot.title")} subtitle={t("auth.forgot.subtitle")} />

        {sent ? (
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-400" data-testid="reset-sent">
            {t("auth.forgot.sent", { email })}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
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
                data-testid="forgot-email"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="forgot-submit"
            >
              {loading ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
            </button>
          </form>
        )}

        <div className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline">
            {t("auth.forgot.backToLogin")}
          </Link>
        </div>
      </div>
    </div>
  );
}
