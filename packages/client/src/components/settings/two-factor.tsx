"use client";

import { passwordSecretForSignedIn } from "@/lib/password-unlock";
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
import { trpc } from "@/lib/trpc";
import { useT } from "@/i18n/use-t";
import type { Translator } from "@/i18n/translator";
import {
  TWO_FACTOR_ALREADY_ENABLED,
  TWO_FACTOR_CODE_INVALID,
  TWO_FACTOR_CODE_REQUIRED,
  TWO_FACTOR_TOO_MANY_ATTEMPTS,
} from "@starter/shared";

type SettingsT = Translator<"settings">;

/**
 * What to say for a refused disable, regenerate or delete-account request.
 * The server checks the password first, then the code (auth/two-factor-guard.ts).
 */
export function confirmRefusalMessage(code: unknown, t: SettingsT): string | null {
  switch (code) {
    case "INVALID_PASSWORD":
      return t("twoFactor.invalidPassword");
    case TWO_FACTOR_CODE_REQUIRED:
    case TWO_FACTOR_CODE_INVALID:
      return t("twoFactor.invalidCodeOrBackup");
    case TWO_FACTOR_TOO_MANY_ATTEMPTS:
      return t("twoFactor.tooManyAttempts");
    default:
      return null;
  }
}

/** The "authenticator code or backup code" field every 2FA confirmation shares. */
export function ConfirmCodeField({
  id,
  value,
  onChange,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
}): React.JSX.Element {
  const t = useT("settings");
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("twoFactor.confirmCode")}</Label>
      <Input
        id={id}
        autoComplete="one-time-code"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      <p className="text-xs text-muted-foreground">{t("twoFactor.confirmCodeHint")}</p>
    </div>
  );
}

/** Six digits lose their spaces; a backup code is sent as typed, trimmed. */
export const normalizeConfirmCode = (code: string): string =>
  /^[\d\s]+$/.test(code) ? code.replace(/\s+/g, "") : code.trim();

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
 * Turning it off, and making new backup codes, ask for the password and a
 * code (authenticator or backup), as the server does: a session plus the
 * password is exactly what two-factor assumes somebody else may hold.
 */
export function TwoFactorRow({ hasPassword }: { hasPassword: boolean | null }): React.JSX.Element {
  const session = authClient.useSession();
  const enabled = session.data?.user.twoFactorEnabled === true;
  const [enableOpen, setEnableOpen] = React.useState(false);
  const [disableOpen, setDisableOpen] = React.useState(false);
  const [regenerateOpen, setRegenerateOpen] = React.useState(false);
  const t = useT("settings");
  const forgetTrusted = trpc.devices.forgetTrustedBrowsers.useMutation({
    onSuccess: ({ forgotten }) => toast.success(t("twoFactor.trustedBrowsers.forgotten", { count: forgotten })),
    onError: () => toast.error(t("twoFactor.trustedBrowsers.failed")),
  });

  return (
    <SettingRow
      title={t("twoFactor.title")}
      description={
        hasPassword === false
          ? t("twoFactor.googleAccount")
          : enabled
            ? t("twoFactor.on")
            : t("twoFactor.off")
      }
      testId="setting-two-factor"
    >
      {enabled ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRegenerateOpen(true)}
            data-testid="two-factor-regenerate"
          >
            {t("twoFactor.regenerate.button")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={forgetTrusted.isPending}
            onClick={() => forgetTrusted.mutate()}
            data-testid="two-factor-forget-trusted"
          >
            {t("twoFactor.trustedBrowsers.button")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDisableOpen(true)}
            data-testid="two-factor-disable"
          >
            {t("twoFactor.turnOff")}
          </Button>
        </div>
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
          {t("twoFactor.turnOn")}
        </Button>
      )}
      <EnableTwoFactorDialog open={enableOpen} onOpenChange={setEnableOpen} />
      <DisableTwoFactorDialog open={disableOpen} onOpenChange={setDisableOpen} />
      <RegenerateBackupCodesDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} />
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
  const t = useT("settings");
  const tc = useT("common");
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
    const secret = await passwordSecretForSignedIn(password).catch(() => password);
    const { data, error: refusal } = await authClient.twoFactor
      .enable({ password: secret })
      .catch(() => ({ data: null, error: { code: "FAILED" } }));
    setBusy(false);
    if (refusal || !data || !("totpURI" in data)) {
      setError(
        refusal?.code === "INVALID_PASSWORD"
          ? t("twoFactor.invalidPassword")
          : refusal?.code === TWO_FACTOR_ALREADY_ENABLED
            ? t("twoFactor.alreadyOn")
            : tc("errors.generic"),
      );
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
      setError(refusal.code === "INVALID_CODE" ? t("twoFactor.invalidCode") : tc("errors.generic"));
      return;
    }
    setCode("");
    setStep({ kind: "codes", backupCodes: step.backupCodes });
    toast.success(t("twoFactor.enabledToast"));
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-testid="two-factor-enable-dialog">
        {step.kind === "password" ? (
          <form onSubmit={(event) => void submitPassword(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("twoFactor.enable.title")}</DialogTitle>
              <DialogDescription>{t("twoFactor.enable.description")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="two-factor-password">{tc("fields.password")}</Label>
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
                {tc("actions.cancel")}
              </Button>
              <Button type="submit" disabled={!password || busy} data-testid="two-factor-password-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {tc("actions.continue")}
              </Button>
            </DialogFooter>
          </form>
        ) : step.kind === "scan" ? (
          <form onSubmit={(event) => void submitCode(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("twoFactor.scan.title")}</DialogTitle>
              <DialogDescription>{t("twoFactor.scan.description")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3">
              <QrCode value={step.totpURI} label={t("twoFactor.scan.qrLabel")} />
              <p className="text-center text-xs text-muted-foreground">
                {t("twoFactor.scan.manualKey")}{" "}
                <code className="break-all rounded bg-muted px-1 py-0.5" data-testid="two-factor-secret">
                  {totpSecretOf(step.totpURI)}
                </code>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="two-factor-verify-code">{t("twoFactor.scan.code")}</Label>
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
                {tc("actions.cancel")}
              </Button>
              <Button type="submit" disabled={!code || busy} data-testid="two-factor-verify-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("twoFactor.scan.verify")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <BackupCodesStep backupCodes={step.backupCodes} onDone={() => change(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The backup codes, shown once: after enrolment and after making new ones. */
function BackupCodesStep({
  backupCodes,
  onDone,
}: {
  backupCodes: string[];
  onDone: () => void;
}): React.JSX.Element {
  const t = useT("settings");
  const tc = useT("common");
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("twoFactor.codes.title")}</DialogTitle>
        <DialogDescription>{t("twoFactor.codes.description")}</DialogDescription>
      </DialogHeader>
      <ul
        className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm"
        data-testid="two-factor-backup-codes"
      >
        {backupCodes.map((backup) => (
          <li key={backup}>{backup}</li>
        ))}
      </ul>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(backupCodes.join("\n"))
              .then(() => toast.success(t("twoFactor.codes.copied")))
              .catch(() => toast.error(t("twoFactor.codes.copyFailed")));
          }}
        >
          {tc("actions.copy")}
        </Button>
        <Button type="button" onClick={onDone} data-testid="two-factor-codes-done">
          {t("twoFactor.codes.saved")}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Password plus a code, for turning 2FA off and for new backup codes. The
 * body's `code` is not in better-auth's types: the guard reads it before the
 * endpoint runs (auth/two-factor-guard.ts).
 */
function PasswordAndCodeDialog({
  open,
  onOpenChange,
  kind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "disable" | "regenerate";
}): React.JSX.Element {
  const t = useT("settings");
  const tc = useT("common");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const prefix = kind === "disable" ? "two-factor-disable" : "two-factor-regenerate";

  const change = (next: boolean): void => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setPassword("");
      setCode("");
      setCodes(null);
      setError(null);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const confirm = normalizeConfirmCode(code);
    if (!password || !confirm || busy) return;
    setBusy(true);
    setError(null);
    const secret = await passwordSecretForSignedIn(password).catch(() => password);
    const body = { password: secret, code: confirm } as { password: string };
    const result =
      kind === "disable"
        ? await authClient.twoFactor
            .disable(body)
            .then(({ error: refusal }) => ({ refusal, backupCodes: null }))
            .catch(() => ({ refusal: { code: "FAILED" }, backupCodes: null }))
        : await authClient.twoFactor
            .generateBackupCodes(body)
            .then(({ data, error: refusal }) => ({ refusal, backupCodes: data?.backupCodes ?? null }))
            .catch(() => ({ refusal: { code: "FAILED" }, backupCodes: null }));
    setBusy(false);
    if (result.refusal) {
      setError(confirmRefusalMessage(result.refusal.code, t) ?? tc("errors.generic"));
      return;
    }
    setPassword("");
    setCode("");
    if (kind === "disable") {
      toast.success(t("twoFactor.disabledToast"));
      change(false);
      return;
    }
    toast.success(t("twoFactor.regenerate.doneToast"));
    setCodes(result.backupCodes ?? []);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-testid={`${prefix}-dialog`}>
        {codes ? (
          <BackupCodesStep backupCodes={codes} onDone={() => change(false)} />
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                {kind === "disable" ? t("twoFactor.disable.title") : t("twoFactor.regenerate.title")}
              </DialogTitle>
              <DialogDescription>
                {kind === "disable"
                  ? t("twoFactor.disable.description")
                  : t("twoFactor.regenerate.description")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-password`}>{tc("fields.password")}</Label>
              <Input
                id={`${prefix}-password`}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                data-testid={`${prefix}-password`}
              />
            </div>
            <ConfirmCodeField
              id={`${prefix}-code`}
              value={code}
              onChange={setCode}
              testId={`${prefix}-code`}
            />
            {error ? <ErrorLine message={error} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                {tc("actions.cancel")}
              </Button>
              <Button
                type="submit"
                variant={kind === "disable" ? "destructive" : "default"}
                disabled={!password || !code.trim() || busy}
                data-testid={`${prefix}-submit`}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {kind === "disable" ? t("twoFactor.turnOff") : t("twoFactor.regenerate.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DisableTwoFactorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return <PasswordAndCodeDialog {...props} kind="disable" />;
}

export function RegenerateBackupCodesDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return <PasswordAndCodeDialog {...props} kind="regenerate" />;
}

export function ErrorLine({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}
