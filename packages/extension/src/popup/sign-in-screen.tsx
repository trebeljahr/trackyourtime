import { useState, type FormEvent, type JSX } from "react";
import { sameServerOrigin } from "@starter/core";
import { BRIDGE_TARGET, DEFAULT_API_URL } from "../lib/config";
import type { DeviceSignInError, PendingDeviceSignIn } from "../lib/messaging";
import { describeServer } from "../lib/server-label";
import { describeDeviceSignInError } from "./errors";
import { join, openTab } from "./open-tab";
import { ServerPicker } from "./server-picker";
import type { SetServerOutcome } from "./switch-server";
import { useT } from "../i18n/use-t";

export type SignInScreenProps = {
  apiUrl: string;
  /** "Track Your Time 0.1.0 (1a2b3c4)", when the server has said. */
  serverVersion: string | null;
  /** The server's web app, when it has said. */
  webUrl: string | null;
  /** Queued changes a server switch would discard. */
  pendingSync: number;
  /** The device sign-in this popup started, while it waits. */
  pendingDeviceAuth: PendingDeviceSignIn | null;
  /** Why the last device sign-in ended without a session. */
  deviceSignInError: DeviceSignInError | null;
  /** The last failure, already translated into human terms. */
  error: string | null;
  onSignIn: (email: string, password: string) => Promise<boolean>;
  onStartDeviceSignIn: () => Promise<boolean>;
  onCancelDeviceSignIn: () => Promise<boolean>;
  onSetServer: (
    origin: string,
    discardUnsent: boolean,
  ) => Promise<SetServerOutcome>;
};

/**
 * Three ways in, for any server.
 *
 * - Email and password, straight in the popup; the session token stays in
 *   the worker.
 * - "Sign in with the web app": the RFC 8628 device flow. The approval page
 *   opens in a tab, the popup shows the code it will show, and the worker
 *   finishes on its own even if the popup closes. It is also the way in for
 *   an account with two-factor authentication, which a password cannot
 *   complete here.
 * - On the hosted service, "Open Track Your Time": a person already signed in
 *   there is signed in here the moment the page loads (`background/bridge.ts`)
 *   — which is also how the extension comes back after a browser restart.
 */
export function SignInScreen({
  apiUrl,
  serverVersion,
  webUrl,
  pendingSync,
  pendingDeviceAuth,
  deviceSignInError,
  error,
  onSignIn,
  onStartDeviceSignIn,
  onCancelDeviceSignIn,
  onSetServer,
}: SignInScreenProps): JSX.Element {
  const t = useT("popup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [changingServer, setChangingServer] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    await onSignIn(email, password);
    setBusy(false);
  };

  const runDevice = async (action: () => Promise<boolean>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await action();
    setBusy(false);
  };

  // Only where the bridge can link it: the hosted web app, for a production
  // build pointed at the hosted server.
  const offerWebApp =
    BRIDGE_TARGET === "production" &&
    webUrl !== null &&
    sameServerOrigin(apiUrl, DEFAULT_API_URL);

  const notice =
    error ?? (deviceSignInError !== null ? describeDeviceSignInError(deviceSignInError, t) : null);

  return (
    <div className="popup__body" data-testid="sign-in-screen">
      <h1 className="popup__title">{t("signIn.title")}</h1>

      {/* Which server the password is about to be sent to, said before the
          form rather than after it: with a self-hosted choice in play, that is
          the thing to check before typing anything. */}
      <div className="server" data-testid="sign-in-server">
        <p className="server__text">
          {t("signIn.signingInTo")}{" "}
          <strong title={apiUrl}>{describeServer(apiUrl, DEFAULT_API_URL, t)}</strong>
          {serverVersion !== null ? (
            <span className="server__version"> · {serverVersion}</span>
          ) : null}
        </p>
        {pendingDeviceAuth === null ? (
          <button
            type="button"
            className="button--link"
            aria-expanded={changingServer}
            onClick={() => setChangingServer((open) => !open)}
            data-testid="sign-in-change-server"
          >
            {changingServer ? t("signIn.keepServer") : t("signIn.changeServer")}
          </button>
        ) : null}
      </div>

      {pendingDeviceAuth !== null ? (
        <div className="panel" data-testid="device-sign-in-waiting">
          <p className="panel__title">{t("signIn.deviceTitle")}</p>
          <p className="panel__hint">{t("signIn.deviceWaiting")}</p>
          <p className="device-code" data-testid="device-user-code">
            {pendingDeviceAuth.userCode}
          </p>
          <button
            type="button"
            className="button button--block"
            disabled={busy}
            onClick={() => void runDevice(onCancelDeviceSignIn)}
            data-testid="device-cancel"
          >
            {t("signIn.deviceCancel")}
          </button>
        </div>
      ) : (
        <>
          {/* Two sibling forms, never nested: the server picker has its own
              submit and must stay usable while the sign-in form is in flight. */}
          {changingServer ? (
            <ServerPicker
              apiUrl={apiUrl}
              pendingSync={pendingSync}
              onSetServer={onSetServer}
              onSwitched={() => setChangingServer(false)}
            />
          ) : null}

          {offerWebApp && webUrl !== null ? (
            <>
              <button
                type="button"
                className="button button--primary button--block"
                onClick={() => openTab(join(webUrl, "/app/track"))}
                data-testid="open-web-app"
              >
                {t("signIn.openWebApp")}
              </button>
              <p className="popup__hint">{t("signIn.openWebAppHint")}</p>
              <p className="sign-in__or">{t("signIn.or")}</p>
            </>
          ) : null}

          <form className="form" onSubmit={submit} data-testid="sign-in-form">
            <div className="field">
              <label className="field__label" htmlFor="email">
                {t("signIn.email")}
              </label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid="sign-in-email"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="password">
                {t("signIn.password")}
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                data-testid="sign-in-password"
              />
            </div>

            <button
              className="button button--primary button--block"
              type="submit"
              disabled={busy}
              data-testid="sign-in-submit"
            >
              {busy ? t("signIn.submitting") : t("signIn.submit")}
            </button>
          </form>

          <p className="sign-in__or">{t("signIn.or")}</p>
          <button
            type="button"
            className="button button--block"
            disabled={busy}
            onClick={() => void runDevice(onStartDeviceSignIn)}
            data-testid="sign-in-web-app"
          >
            {t("signIn.withWebApp")}
          </button>
          <p className="popup__hint">{t("signIn.withWebAppHint")}</p>
        </>
      )}

      <p className="notice" role="alert" aria-live="assertive" data-testid="sign-in-error">
        {notice ?? ""}
      </p>
    </div>
  );
}
