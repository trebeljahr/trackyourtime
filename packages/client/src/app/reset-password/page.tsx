"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { AuthHeader } from "@/components/auth-header";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const t = useT("shell");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError(translate("shell")("auth.passwordsDoNotMatch"));
      return;
    }

    setLoading(true);

    try {
      await authClient.resetPassword({ newPassword, token });
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
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="newPassword" className="text-sm font-medium">
          {t("auth.newPassword")}
        </label>
        <input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="reset-new-password"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          {t("auth.confirmPassword")}
        </label>
        <input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
