"use client";

import * as React from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  AuthError,
  pollForDeviceSession,
  startDeviceAuthorization,
  type DeviceAuthorization,
} from "@starter/core";

import { Button } from "@/components/ui/button";
import { useIsElectron } from "@/hooks/use-shell";
import { useT } from "@/i18n/use-t";
import { getAbsoluteApiOrigin, whenApiOriginReady } from "@/lib/api-origin";
import { setNativeToken } from "@/lib/native-session";

/**
 * "Sign in with your browser", on /login in the desktop app.
 *
 * The password form in a shell cannot finish a two-factor challenge (the
 * challenge is a cookie the app never sends) and cannot do Google at all (the
 * OAuth redirect cannot come back to `app://-`). The browser the person
 * already uses has passed both. So the app runs the RFC 8628 device flow the
 * Raycast extension uses — `startDeviceAuthorization` / `pollForDeviceSession`
 * from `@starter/core`, client id `trackyourtime-desktop` — opens the approval
 * page in the OS browser and waits. No server change: the server already
 * allowlists the id and gives it the stored-token session lifetime.
 *
 * Renders nothing on web and on the first client render anywhere
 * (`useIsElectron` hydrates as `false`), so the prerendered login page is
 * unchanged.
 */

export const DESKTOP_CLIENT_ID = "trackyourtime-desktop";

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; authorization: DeviceAuthorization };

export type BrowserSignInFailure = "denied" | "expired" | "failed" | "cancelled";

/** What a device-flow error means to the person, by the RFC 8628 code. */
export const browserSignInFailure = (error: unknown): BrowserSignInFailure => {
  const code = error instanceof AuthError ? error.code : null;
  if (code === "CANCELLED") return "cancelled";
  if (code === "access_denied") return "denied";
  if (code === "expired_token" || code === "EXPIRED_TOKEN") return "expired";
  return "failed";
};

const FAILURE_MESSAGES = {
  denied: "auth.browserSignIn.denied",
  expired: "auth.browserSignIn.expired",
  failed: "auth.browserSignIn.failed",
} as const;

/** Every request of the flow: the chosen server, never a cookie. */
const deviceFetch: typeof fetch = (input, init) => fetch(input, { ...init, credentials: "omit" });

/** A sleep that ends early, and rejects, when the wait is cancelled. */
const abortableSleep =
  (signal: AbortSignal) =>
  (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AuthError("Cancelled", "CANCELLED"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new AuthError("Cancelled", "CANCELLED"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

export function BrowserSignIn({
  onSignedIn,
}: {
  /** Called once the token is stored; the page refreshes the session and navigates. */
  onSignedIn: () => Promise<void>;
}): React.JSX.Element | null {
  const desktop = useIsElectron();
  const t = useT("shell");
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [error, setError] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);

  // Leaving the page stops the poll; nothing may store a token for a screen
  // that is gone.
  React.useEffect(() => () => abort.current?.abort(), []);

  if (!desktop) return null;

  const openApproval = (authorization: DeviceAuthorization): void => {
    const url = authorization.verificationUriComplete || authorization.verificationUri;
    if (url) void window.electronAPI?.openExternal(url);
  };

  const start = async (): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setPhase({ kind: "starting" });

    try {
      await whenApiOriginReady();
      const options = {
        baseUrl: getAbsoluteApiOrigin(),
        clientId: DESKTOP_CLIENT_ID,
        fetchImpl: deviceFetch,
      } as const;
      const authorization = await startDeviceAuthorization(options);
      if (controller.signal.aborted) return;
      setPhase({ kind: "waiting", authorization });
      openApproval(authorization);

      const session = await pollForDeviceSession(options, authorization.deviceCode, {
        intervalSeconds: authorization.intervalSeconds,
        timeoutSeconds: authorization.expiresInSeconds,
        signal: controller.signal,
        sleepImpl: abortableSleep(controller.signal),
      });
      if (controller.signal.aborted) return;
      await setNativeToken(session.token);
      await onSignedIn();
    } catch (caught) {
      if (controller.signal.aborted) return;
      const failure = browserSignInFailure(caught);
      if (failure !== "cancelled") setError(t(FAILURE_MESSAGES[failure]));
      setPhase({ kind: "idle" });
    }
  };

  const cancel = (): void => {
    abort.current?.abort();
    abort.current = null;
    setPhase({ kind: "idle" });
  };

  if (phase.kind === "waiting") {
    return (
      <div className="space-y-3 rounded-md border border-border p-4 text-sm" data-testid="browser-sign-in-waiting">
        <p className="font-medium">{t("auth.browserSignIn.waitingTitle")}</p>
        <p className="text-muted-foreground">{t("auth.browserSignIn.waiting")}</p>
        <p
          className="text-center font-mono text-2xl font-semibold tracking-widest"
          data-testid="browser-sign-in-code"
        >
          {phase.authorization.userCode}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => openApproval(phase.authorization)}
            data-testid="browser-sign-in-reopen"
          >
            <ExternalLink className="size-4" />
            {t("auth.browserSignIn.reopen")}
          </Button>
          <Button type="button" variant="ghost" onClick={cancel} data-testid="browser-sign-in-cancel">
            {t("auth.browserSignIn.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <div
          className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          data-testid="browser-sign-in-error"
        >
          {error}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={phase.kind === "starting"}
        onClick={() => void start()}
        data-testid="browser-sign-in"
      >
        {phase.kind === "starting" ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
        {phase.kind === "starting" ? t("auth.browserSignIn.starting") : t("auth.browserSignIn.start")}
      </Button>
      <p className="text-center text-xs text-muted-foreground">{t("auth.browserSignIn.hint")}</p>
    </div>
  );
}
