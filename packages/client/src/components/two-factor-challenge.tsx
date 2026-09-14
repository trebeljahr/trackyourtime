"use client";

import * as React from "react";

import { authClient } from "@/lib/auth-client";

type Method = "totp" | "backup";

/**
 * Shown by /login instead of the second step on a native shell. The challenge
 * is a cookie a WKWebView cannot send to the API, so the step could never
 * succeed there; saying so beats a code field that always answers "invalid".
 * The native-clients follow-up replaces this with a real step.
 */
export const NATIVE_TWO_FACTOR_UNSUPPORTED =
  "This account uses two-factor authentication, which the app does not support yet. Sign in on the web app instead.";

export const EMAIL_NOT_VERIFIED_MESSAGE =
  "Verify your email address first. We sent a new verification link to your inbox.";

/** What the challenge screen tells the page once it is done. */
export type ChallengeOutcome = "verified" | "expired";

const inputClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/**
 * The second step of /login for an account with two-factor authentication.
 *
 * The password step already happened: the server answered it with a signed
 * challenge cookie instead of a session, and both verify calls below read
 * that cookie. A backup code works once — the server removes it on use.
 *
 * A challenge lasts ten minutes. When it has expired the server says
 * INVALID_TWO_FACTOR_COOKIE, and the only way on is the password again, so
 * that answer goes back to the page rather than reading as a wrong code.
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

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = code.replace(/\s+/g, "");
    if (!trimmed || verifying) return;
    setVerifying(true);
    setError("");
    try {
      const result =
        method === "totp"
          ? await authClient.twoFactor.verifyTotp({ code: trimmed })
          : await authClient.twoFactor.verifyBackupCode({ code: trimmed });
      if (result.error) {
        if (result.error.code === "INVALID_TWO_FACTOR_COOKIE") {
          await onDone("expired");
          return;
        }
        setError(
          method === "totp"
            ? "That code is not valid. Check the time on your device and try the next code."
            : "That backup code is not valid or has already been used.",
        );
        setVerifying(false);
        return;
      }
      await onDone("verified");
    } catch {
      setError("An unexpected error occurred");
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
          {method === "totp" ? "Authentication code" : "Backup code"}
        </label>
        <p className="text-sm text-muted-foreground">
          {method === "totp"
            ? "Enter the 6-digit code from your authenticator app."
            : "Enter one of the backup codes you saved when you turned on two-factor authentication. Each code works once."}
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

      <button
        type="submit"
        disabled={verifying}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="two-factor-submit"
      >
        {verifying ? "Verifying..." : "Verify"}
      </button>

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={switchMethod}
          className="text-primary hover:underline"
          data-testid="two-factor-switch"
        >
          {method === "totp" ? "Use a backup code" : "Use an authenticator code"}
        </button>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:underline">
          Back
        </button>
      </div>
    </form>
  );
}
