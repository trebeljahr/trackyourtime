"use client";

import * as React from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { encode } from "uqr";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { SettingRow } from "@/components/settings/setting-row";
import { authClient } from "@/lib/auth-client";

/** The `secret` of an `otpauth://` URI, for typing into an app by hand. */
export function totpSecretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/** A QR code as plain SVG rects — no canvas, no innerHTML. */
export function QrCode({ value, label }: { value: string; label: string }): React.JSX.Element {
  const qr = React.useMemo(() => encode(value, { border: 2 }), [value]);
  const cells: React.JSX.Element[] = [];
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />);
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="size-44 rounded-md bg-white p-1 text-black"
      shapeRendering="crispEdges"
      data-testid="two-factor-qr"
    >
      <g fill="currentColor">{cells}</g>
    </svg>
  );
}

const INVALID_PASSWORD = "That password is not correct.";
const GENERIC = "Something went wrong. Try again.";

type EnableStep =
  | { kind: "password" }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

/**
 * Settings → Account → Two-factor authentication.
 *
 * Turning it on is three steps, and the order is the safety: the password
 * proves it is the account holder; scanning and confirming a code proves the
 * authenticator really has the secret (the server switches 2FA on only then,
 * so a dialog closed half-way locks nobody out); the backup codes are shown
 * last and once, because the server stores them encrypted and cannot show
 * them again.
 *
 * Turning it off asks for the password, as the server does.
 */
export function TwoFactorRow({ hasPassword }: { hasPassword: boolean | null }): React.JSX.Element {
  const session = authClient.useSession();
  const enabled = session.data?.user.twoFactorEnabled === true;
  const [enableOpen, setEnableOpen] = React.useState(false);
  const [disableOpen, setDisableOpen] = React.useState(false);

  return (
    <SettingRow
      title="Two-factor authentication"
      description={
        hasPassword === false
          ? "Your account signs in with Google, which has its own two-factor settings."
          : enabled
            ? "On. Signing in needs a code from your authenticator app or a backup code."
            : "Off. Add a code from an authenticator app to every sign-in."
      }
      testId="setting-two-factor"
    >
      {enabled ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDisableOpen(true)}
          data-testid="two-factor-disable"
        >
          Turn off
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={hasPassword !== true}
          onClick={() => setEnableOpen(true)}
          data-testid="two-factor-enable"
        >
          <ShieldCheck className="size-4" />
          Turn on
        </Button>
      )}
      <EnableTwoFactorDialog open={enableOpen} onOpenChange={setEnableOpen} />
      <DisableTwoFactorDialog open={disableOpen} onOpenChange={setDisableOpen} />
    </SettingRow>
  );
}

export function EnableTwoFactorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [step, setStep] = React.useState<EnableStep>({ kind: "password" });
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const change = (next: boolean): void => {
    if (busy) return;
    // Closing on the codes step is the only way out of it, and the codes
    // are gone after that. The button says so.
    onOpenChange(next);
    if (!next) {
      setStep({ kind: "password" });
      setPassword("");
      setCode("");
      setError(null);
    }
  };

  const submitPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const { data, error: refusal } = await authClient.twoFactor
      .enable({ password })
      .catch(() => ({ data: null, error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal || !data) {
      setError(refusal?.code === "INVALID_PASSWORD" ? INVALID_PASSWORD : GENERIC);
      return;
    }
    setPassword("");
    setStep({ kind: "scan", totpURI: data.totpURI, backupCodes: data.backupCodes });
  };

  const submitCode = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (step.kind !== "scan" || busy) return;
    const trimmed = code.replace(/\s+/g, "");
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient.twoFactor
      .verifyTotp({ code: trimmed })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError(
        refusal.code === "INVALID_CODE"
          ? "That code is not valid. Check the time on your device and try the next code."
          : GENERIC,
      );
      return;
    }
    setCode("");
    setStep({ kind: "codes", backupCodes: step.backupCodes });
    toast.success("Two-factor authentication is on");
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-testid="two-factor-enable-dialog">
        {step.kind === "password" ? (
          <form onSubmit={(event) => void submitPassword(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Turn on two-factor authentication</DialogTitle>
              <DialogDescription>
                Every sign-in on the web will ask for a code from an authenticator
                app. Until the mobile app and the browser extension support it,
                they cannot sign in to this account; devices that are already
                signed in stay signed in.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="two-factor-password">Password</Label>
              <Input
                id="two-factor-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                data-testid="two-factor-password"
              />
            </div>
            {error ? <ErrorLine message={error} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!password || busy} data-testid="two-factor-password-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Continue
              </Button>
            </DialogFooter>
          </form>
        ) : step.kind === "scan" ? (
          <form onSubmit={(event) => void submitCode(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Scan the QR code</DialogTitle>
              <DialogDescription>
                Scan it with your authenticator app, then enter the 6-digit code
                the app shows.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3">
              <QrCode value={step.totpURI} label="QR code for your authenticator app" />
              <p className="text-center text-xs text-muted-foreground">
                Cannot scan it? Enter this key:{" "}
                <code className="break-all rounded bg-muted px-1 py-0.5" data-testid="two-factor-secret">
                  {totpSecretOf(step.totpURI)}
                </code>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="two-factor-verify-code">Code</Label>
              <Input
                id="two-factor-verify-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                data-testid="two-factor-verify-code"
              />
            </div>
            {error ? <ErrorLine message={error} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!code || busy} data-testid="two-factor-verify-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Verify
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Save your backup codes</DialogTitle>
              <DialogDescription>
                Each code signs you in once if you lose your authenticator app.
                Store them somewhere safe. They are not shown again.
              </DialogDescription>
            </DialogHeader>
            <ul
              className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm"
              data-testid="two-factor-backup-codes"
            >
              {step.backupCodes.map((backup) => (
                <li key={backup}>{backup}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(step.backupCodes.join("\n"))
                    .then(() => toast.success("Backup codes copied"))
                    .catch(() => toast.error("Could not copy. Select the codes instead."));
                }}
              >
                Copy
              </Button>
              <Button type="button" onClick={() => change(false)} data-testid="two-factor-codes-done">
                I saved them
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DisableTwoFactorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const change = (next: boolean): void => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setPassword("");
      setError(null);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient.twoFactor
      .disable({ password })
      .catch(() => ({ error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal) {
      setError(refusal.code === "INVALID_PASSWORD" ? INVALID_PASSWORD : GENERIC);
      return;
    }
    toast.success("Two-factor authentication is off");
    change(false);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-testid="two-factor-disable-dialog">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication?</DialogTitle>
            <DialogDescription>
              Signing in will need only your password. Your backup codes stop working.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="two-factor-disable-password">Password</Label>
            <Input
              id="two-factor-disable-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="two-factor-disable-password"
            />
          </div>
          {error ? <ErrorLine message={error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!password || busy}
              data-testid="two-factor-disable-submit"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ErrorLine({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}
