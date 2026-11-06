"use client";

import { finishPasswordUnlockForSession } from "@/lib/password-unlock";
import * as React from "react";

import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t";
import { useIsTokenShell } from "@/hooks/use-shell";
import { TWO_FACTOR_TRUST_DAYS } from "@starter/shared";

type Method = "totp" | "backup";

/** What the challenge screen tells the page once it is done. */
export type ChallengeOutcome = "verified" | "expired" | "too-many-codes";

const inputClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/**
 * The second step of /login for an account with two-factor authentication.
 *
 * The password step already happened: the server answered it with a signed
 * challenge instead of a session, which `lib/two-factor-challenge.ts` holds
 * and the auth client sends back on both verify calls below — as a header, so
 * the phone and desktop apps, which carry no cookies, take the same path. A
 * backup code works once — the server removes it on use, and an authenticator
 * code works once too.
 *
 * A challenge lasts ten minutes and takes five wrong codes. Past either the
 * server drops it, and the only way on is the password again, so those
 * answers go back to the page rather than reading as a wrong code. Ten wrong
 * codes across challenges lock the account's sign-in for fifteen minutes.
 */
export function TwoFactorChallenge({
  onDone,
  onCancel,
}: {
  onDone: (outcome: ChallengeOutcome) => void | Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [method, setMethod] = React.useState<Method>("totp");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [verifying, setVerifying] = React.useState(false);
  const [trust, setTrust] = React.useState(false);
  // The trust cookie lives in the browser's cookie jar; the phone and desktop
  // apps send no cookies, so the box would promise something they cannot keep.
  const tokenShell = useIsTokenShell();
  const t = useT("shell");
  const tc = useT("common");

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = code.replace(/\s+/g, "");
    if (!trimmed || verifying) return;
    setVerifying(true);
    setError("");
    try {
      const trustDevice = trust && !tokenShell ? { trustDevice: true } : {};
      const result =
        method === "totp"
          ? await authClient.twoFactor.verifyTotp({ code: trimmed, ...trustDevice })
          : await authClient.twoFactor.verifyBackupCode({ code: trimmed, ...trustDevice });
      if (result.error) {
        if (result.error.code === "INVALID_TWO_FACTOR_COOKIE") {
          await onDone("expired");
          return;
        }
        // Five wrong codes: the server dropped this challenge.
        if (result.error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
          await onDone("too-many-codes");
          return;
        }
        if (result.error.code === "ACCOUNT_TEMPORARILY_LOCKED") {
          setError(t("auth.twoFactor.locked"));
          setVerifying(false);
          return;
        }
        setError(
          method === "totp" ? t("auth.twoFactor.invalidTotp") : t("auth.twoFactor.invalidBackup"),
        );
        setVerifying(false);
        return;
      }
      // The password step already derived the key; finish unlocking now that a
      // session exists (lib/password-unlock.ts).
      await finishPasswordUnlockForSession();
      await onDone("verified");
    } catch {
      setError(t("auth.twoFactor.unexpected"));
      setVerifying(false);
    }
  };

  const switchMethod = (): void => {
    setMethod((current) => (current === "totp" ? "backup" : "totp"));
    setCode("");
    setError("");
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" data-testid="login-two-factor">
      {error ? (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="two-factor-error">
          {error}
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="two-factor-code" className="text-sm font-medium">
          {method === "totp" ? t("auth.twoFactor.totpLabel") : t("auth.twoFactor.backupLabel")}
        </label>
        <p className="text-sm text-muted-foreground">
          {method === "totp" ? t("auth.twoFactor.totpHint") : t("auth.twoFactor.backupHint")}
        </p>
        <input
          id="two-factor-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode={method === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          autoFocus
          required
          className={inputClass}
          data-testid="two-factor-code"
        />
      </div>

      {tokenShell ? null : (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm" htmlFor="two-factor-trust">
            <input
              id="two-factor-trust"
              type="checkbox"
              checked={trust}
              onChange={(event) => setTrust(event.target.checked)}
              className="size-4"
              data-testid="two-factor-trust"
            />
            {t("auth.twoFactor.trust", { days: TWO_FACTOR_TRUST_DAYS })}
          </label>
          <p className="text-xs text-muted-foreground">{t("auth.twoFactor.trustHint")}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={verifying}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="two-factor-submit"
      >
        {verifying ? t("auth.twoFactor.verifying") : t("auth.twoFactor.verify")}
      </button>

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={switchMethod}
          className="text-primary hover:underline"
          data-testid="two-factor-switch"
        >
          {method === "totp" ? t("auth.twoFactor.useBackup") : t("auth.twoFactor.useTotp")}
        </button>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:underline">
          {tc("actions.back")}
        </button>
      </div>
    </form>
  );
}
