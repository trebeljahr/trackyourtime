import { useState, type FormEvent, type JSX } from "react";
import { LoaderCircle, Pencil } from "lucide-react";
import { sameServerOrigin } from "@starter/core";
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
  const [busyAction, setBusyAction] = useState<"email" | "device" | "web" | "cancel" | null>(null);
  const busy = busyAction !== null;
  const [changingServer, setChangingServer] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusyAction("email");
    try { await onSignIn(email, password); } finally { setBusyAction(null); }
  };

  const runDevice = async (kind: "device" | "web" | "cancel", action: () => Promise<boolean>): Promise<void> => {
    if (busy) return;
    setBusyAction(kind);
    try { await action(); } finally { setBusyAction(null); }
  };

  const notice =
    error ?? (deviceSignInError !== null ? describeDeviceSignInError(deviceSignInError, t) : null);
  const signupUrl = webUrl ??
    (sameServerOrigin(apiUrl, "https://api.trackyourtime.dev") ? "https://trackyourtime.dev" : null);

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
        {pendingDeviceAuth !== null ? (
          <div className="panel" data-testid="device-sign-in-waiting">
            <p className="panel__title">{t(pendingDeviceAuth.webAccount ? "signIn.webAccountWaitingTitle" : "signIn.deviceTitle")}</p>
            <p className="panel__hint">{t(pendingDeviceAuth.webAccount ? "signIn.webAccountWaiting" : "signIn.deviceWaiting")}</p>
            {!pendingDeviceAuth.webAccount ? (
              <p className="device-code" data-testid="device-user-code">{pendingDeviceAuth.userCode}</p>
            ) : null}
            {!pendingDeviceAuth.webAccount && pendingDeviceAuth.verificationUrl ? (
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
              onClick={() => void runDevice("cancel", onCancelDeviceSignIn)}
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
                {busyAction === "email" ? t("signIn.submitting") : t("signIn.submit")}
              </button>
            </form>

            <p className="sign-in__or">{t("signIn.or")}</p>
            <button
              type="button"
              className="button button--block"
              disabled={busy}
              onClick={() => void runDevice("device", onStartDeviceSignIn)}
              aria-busy={busyAction === "device"}
              data-testid="sign-in-web-app"
            >
              {busyAction === "device" ? <LoaderCircle className="sign-in__spinner" size={16} aria-hidden="true" /> : null}
              {t("signIn.withWebApp")}
            </button>
            {webAccount && onConfirmWebAccount ? (
              <>
                <p className="sign-in__or">{t("signIn.or")}</p>
                <button
                  type="button"
                  className="button button--block web-account__button"
                  disabled={busy}
                  onClick={() => void runDevice("web", () => onConfirmWebAccount(webAccount.userId, webAccount.sessionCreatedAt))}
                  aria-busy={busyAction === "web"}
                  data-testid="open-web-app"
                >
                  <span className="web-account__avatar" aria-hidden="true">
                    {busyAction === "web" ? <LoaderCircle className="sign-in__spinner" size={18} /> : webAccount.email.charAt(0).toUpperCase()}
                    {webAccount.image && busyAction !== "web" ? <img key={webAccount.image} src={webAccount.image} alt="" referrerPolicy="no-referrer"
                      onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
                  </span>
                  <span className="web-account__identity" data-testid="web-account-identity">
                    <span>{busyAction === "web" ? t("signIn.submitting") : t("signIn.openWebApp")}</span>
                    <strong className="web-account__email">{webAccount.email}</strong>
                  </span>
                </button>
              </>
            ) : null}
          </>
        )}

        <p className="notice" role="alert" aria-live="assertive" data-testid="sign-in-error">
          {notice ?? ""}
        </p>
        {pendingDeviceAuth === null && webAccount === null && signupUrl ? (
          <button
            type="button"
            className="sign-in__signup"
            onClick={() => openTab(join(signupUrl, "/signup/"))}
            data-testid="sign-in-signup"
          >
            {t("signIn.noAccount")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
