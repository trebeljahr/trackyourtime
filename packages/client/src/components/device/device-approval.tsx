"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, MonitorSmartphone, XCircle } from "lucide-react";
import { deviceCodeSchema } from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { translate } from "@/i18n/translate";
import { useT } from "@/i18n/use-t";
import { decideDeviceCode, type DeviceAuthError } from "@/lib/device-approve";
import { trpc } from "@/lib/trpc";

type Outcome =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/** RFC 8628 error code → catalog key. */
const ERROR_KEYS = {
  invalid_request: "device.errors.invalidRequest",
  expired_token: "device.errors.expiredToken",
  access_denied: "device.errors.accessDenied",
  device_code_already_processed: "device.errors.alreadyProcessed",
  unauthorized: "device.errors.unauthorized",
} as const;

const isKnownError = (code: string): code is keyof typeof ERROR_KEYS =>
  Object.hasOwn(ERROR_KEYS, code);

/** Called when the error happens, so it reads the language active right then. */
const readError = (error: DeviceAuthError, fallback: string): string => {
  const code = error.error;
  if (code && isKnownError(code)) return translate("settings")(ERROR_KEYS[code]);
  return error.error_description ?? error.message ?? fallback;
};

/**
 * Approve (or decline) a pairing code from a client that cannot show a
 * sign-in form. On approval the waiting client's next poll gets a real
 * session and it shows up in Settings → Devices like any other app.
 */
export function DeviceApproval(): React.JSX.Element {
  const utils = trpc.useUtils();
  const t = useT("settings");
  const prefill = useSearchParams().get("user_code") ?? "";
  const [code, setCode] = React.useState(prefill);
  const [outcome, setOutcome] = React.useState<Outcome>({ kind: "idle" });

  // A code handed over via `verification_uri_complete` arrives after the first
  // client render, so mirror it into the field once it appears.
  React.useEffect(() => {
    if (prefill) setCode(prefill);
  }, [prefill]);

  const parsed = deviceCodeSchema.safeParse({ userCode: code });
  const busy = outcome.kind === "working";

  const run = async (action: "approve" | "deny"): Promise<void> => {
    if (!parsed.success) return;
    const userCode = parsed.data.userCode;
    setOutcome({ kind: "working" });

    const result = await decideDeviceCode(userCode, action);
    if (result.ok) {
      setOutcome({ kind: action === "approve" ? "approved" : "denied" });
      // The newly paired client is now a device — refresh the settings list.
      void utils.devices.list.invalidate();
      return;
    }
    if (result.stage === "network") {
      setOutcome({
        kind: "error",
        message: translate("settings")("device.errors.network"),
      });
      return;
    }
    const fallback =
      result.stage === "claim"
        ? "device.errors.claimFailed"
        : action === "approve"
          ? "device.errors.approveFailed"
          : "device.errors.denyFailed";
    setOutcome({
      kind: "error",
      message: readError(result.error, translate("settings")(fallback)),
    });
  };

  if (outcome.kind === "approved" || outcome.kind === "denied") {
    return (
      <ResultCard
        approved={outcome.kind === "approved"}
        onReset={() => {
          setCode("");
          setOutcome({ kind: "idle" });
        }}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-md" data-testid="device-approval">
      <Card>
        <CardHeader className="space-y-1.5">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MonitorSmartphone className="size-5" />
          </span>
          <CardTitle>{t("device.title")}</CardTitle>
          <CardDescription>{t("device.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run("approve");
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="device-user-code">{t("device.code")}</Label>
              <Input
                id="device-user-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="one-time-code"
                autoFocus
                spellCheck={false}
                className="font-mono tracking-widest uppercase"
                data-testid="device-code-input"
              />
              <p className="text-xs text-muted-foreground">
                {t("device.codeHint")}
              </p>
            </div>

            {outcome.kind === "error" ? (
              <p
                className="text-sm text-destructive"
                role="alert"
                data-testid="device-code-error"
              >
                {outcome.message}
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button
                type="submit"
                className="flex-1"
                disabled={!parsed.success || busy}
                data-testid="device-approve"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("device.approve")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!parsed.success || busy}
                onClick={() => void run("deny")}
                data-testid="device-deny"
              >
                {t("device.decline")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

type ResultCardProps = { approved: boolean; onReset: () => void };

function ResultCard({ approved, onReset }: ResultCardProps): React.JSX.Element {
  const Icon = approved ? CheckCircle2 : XCircle;
  const t = useT("settings");
  return (
    <div className="mx-auto w-full max-w-md" data-testid="device-approval-result">
      <Card>
        <CardHeader className="space-y-1.5">
          <span
            className={
              approved
                ? "flex size-10 items-center justify-center rounded-full bg-muted text-foreground"
                : "flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
            }
          >
            <Icon className="size-5" />
          </span>
          <CardTitle>
            {approved ? t("device.result.approvedTitle") : t("device.result.deniedTitle")}
          </CardTitle>
          <CardDescription>
            {approved
              ? t("device.result.approvedDescription")
              : t("device.result.deniedDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button asChild data-testid="device-result-settings">
            <Link href="/app/settings">{t("device.result.openSettings")}</Link>
          </Button>
          <Button variant="ghost" onClick={onReset} data-testid="device-result-again">
            {t("device.result.again")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
