import { useState, type FormEvent, type JSX } from "react";
import { DEFAULT_API_URL } from "../lib/config";
import { describeServer } from "../lib/server-label";
import { ServerPicker } from "./server-picker";
import type { SetServerOutcome } from "./switch-server";
import { useT } from "../i18n/use-t";

export type SignInScreenProps = {
  apiUrl: string;
  /** "Track Your Time 0.1.0 (1a2b3c4)", when the server has said. */
  serverVersion: string | null;
  /** Queued changes a server switch would discard. */
  pendingSync: number;
  /** The last failure, already translated into human terms. */
  error: string | null;
  onSignIn: (email: string, password: string) => Promise<boolean>;
  onSetServer: (
    origin: string,
    discardUnsent: boolean,
  ) => Promise<SetServerOutcome>;
};

/**
 * Email + password, straight in the popup.
 *
 * The device flow core also offers is for clients that cannot show a form
 * (Raycast, a CLI); a popup can, so it uses the direct password grant and
 * keeps the resulting session token in the worker.
 */
export function SignInScreen({
  apiUrl,
  serverVersion,
  pendingSync,
  error,
  onSignIn,
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

  return (
    <div className="popup__body" data-testid="sign-in-screen">
      <h1 className="popup__title">{t("signIn.title")}</h1>

      {/* Which server the password is about to be sent to, said before the
          form rather than after it: with a self-hosted choice in play, that is
          the thing to check before typing anything. */}
      <div className="server" data-testid="sign-in-server">
        <p className="server__text">
          {t("signIn.signingInTo")}{" "}
          <strong title={apiUrl}>{describeServer(apiUrl, DEFAULT_API_URL)}</strong>
          {serverVersion !== null ? (
            <span className="server__version"> · {serverVersion}</span>
          ) : null}
        </p>
        <button
          type="button"
          className="button--link"
          aria-expanded={changingServer}
          onClick={() => setChangingServer((open) => !open)}
          data-testid="sign-in-change-server"
        >
          {changingServer ? t("signIn.keepServer") : t("signIn.changeServer")}
        </button>
      </div>

      {/* Two sibling forms, never nested: the server picker has its own submit
          and must stay usable while the sign-in form is in flight. */}
      {changingServer ? (
        <ServerPicker
          apiUrl={apiUrl}
          pendingSync={pendingSync}
          onSetServer={onSetServer}
          onSwitched={() => setChangingServer(false)}
        />
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

      <p className="notice" role="alert" aria-live="assertive" data-testid="sign-in-error">
        {error ?? ""}
      </p>
    </div>
  );
}
