import { useState, type FormEvent, type JSX } from "react";
import { Pencil } from "lucide-react";
import { sameServerOrigin } from "@starter/core";
import { BRIDGE_TARGET } from "../lib/config";
import type { DeviceSignInError, PendingDeviceSignIn } from "../lib/messaging";
import { describeDeviceSignInError } from "./errors";
import { join, openTab } from "./open-tab";
import { ServerPicker } from "./server-picker";
import { Header } from "./header";
import type { WebAccount } from "../lib/web-account";
import type { SetServerOutcome } from "./switch-server";
import { useT } from "../i18n/use-t";

export type SignInScreenProps = {
  apiUrl: string;
  webAccount?: WebAccount | null;
  onConfirmWebAccount?: (userId: string, sessionCreatedAt: number) => Promise<boolean>;
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

/** Every server offers explicit sign-in, even when web-session linking is available. */
export function SignInScreen({
  apiUrl,
  webAccount = null,
  onConfirmWebAccount,
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

  // Use the known hosted URL even before server discovery finishes. A custom
  // server or a build without the web bridge must retain manual sign-in.
  const automaticWebUrl =
    BRIDGE_TARGET === "production" &&
    sameServerOrigin(apiUrl, "https://api.trackyourtime.dev") &&
    (webUrl === null || sameServerOrigin(webUrl, "https://trackyourtime.dev"))
      ? "https://trackyourtime.dev"
      : null;

  const notice =
    error ?? (deviceSignInError !== null ? describeDeviceSignInError(deviceSignInError, t) : null);

  return (
    <div className="screen" data-testid="sign-in-screen">
      <Header title="Track Your Time" branded trailingAction={
        <button
          type="button"
          className="sign-in__server"
          title={apiUrl}
          aria-label={t("signIn.editServer")}
          aria-expanded={changingServer}
          aria-controls="sign-in-server-picker"
          disabled={pendingDeviceAuth !== null || busy}
          onClick={() => setChangingServer((open) => !open)}
          data-testid="sign-in-change-server"
        >
          <span>{t(sameServerOrigin(apiUrl, "https://api.trackyourtime.dev") ? "signIn.usingCloud" : "signIn.usingOwnServer")}</span>
          <Pencil size={12} aria-hidden="true" />
        </button>
      } />
      <div className="popup__body">
        {webAccount !== null && pendingDeviceAuth === null && !changingServer && onConfirmWebAccount ? (
          <button type="button" className="button button--primary button--block sign-in__web-login" disabled={busy}
            data-testid="confirm-web-account"
            onClick={() => void runDevice(() => onConfirmWebAccount(webAccount.userId, webAccount.sessionCreatedAt))}>
            <span>{busy ? t("signIn.submitting") : t("signIn.autoLoginAs")}</span>
            <span className="web-account__identity">
              <span className="web-account__avatar" aria-hidden="true">
                {webAccount.email.charAt(0).toUpperCase()}
                {webAccount.image ? <img key={webAccount.image} src={webAccount.image} alt="" referrerPolicy="no-referrer"
                  onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
              </span>
              <strong className="web-account__email">{webAccount.email}</strong>
            </span>
          </button>
        ) : null}

        {pendingDeviceAuth !== null ? (
          <div className="panel" data-testid="device-sign-in-waiting">
            <p className="panel__title">{t(pendingDeviceAuth.webAccount ? "signIn.webAccountWaitingTitle" : "signIn.deviceTitle")}</p>
            <p className="panel__hint">{t(pendingDeviceAuth.webAccount ? "signIn.webAccountWaiting" : "signIn.deviceWaiting")}</p>
            <p className="device-code" data-testid="device-user-code">
              {pendingDeviceAuth.userCode}
            </p>
            {pendingDeviceAuth.verificationUrl ? (
              <button
                type="button"
                className="button button--primary button--block"
                onClick={() => openTab(pendingDeviceAuth.verificationUrl!)}
                data-testid="device-continue"
              >
                {t("signIn.deviceContinue")}
              </button>
            ) : null}
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
              <div className="panel" id="sign-in-server-picker">
                <p className="panel__hint">{t("signIn.serverExplanation")}</p>
                <ServerPicker
                  apiUrl={apiUrl}
                  pendingSync={pendingSync}
                  onSetServer={onSetServer}
                  onSwitched={() => setChangingServer(false)}
                />
              </div>
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
            {automaticWebUrl && !webAccount ? (
              <>
                <button
                  type="button"
                  className="button button--block"
                  onClick={() => openTab(join(automaticWebUrl, "/app/track"))}
                  data-testid="open-web-app"
                >
                  {t("signIn.openWebApp")}
                </button>
              </>
            ) : null}
          </>
        )}

        <p className="notice" role="alert" aria-live="assertive" data-testid="sign-in-error">
          {notice ?? ""}
        </p>
      </div>
    </div>
  );
}
