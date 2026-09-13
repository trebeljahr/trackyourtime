import { useState, type FormEvent, type JSX } from "react";
import { ApiUrlEditor } from "./api-url-editor";

export type SignInScreenProps = {
  apiUrl: string;
  /** The last failure, already translated into human terms. */
  error: string | null;
  onSignIn: (email: string, password: string) => Promise<boolean>;
  onSaveApiUrl: (apiUrl: string) => Promise<boolean>;
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
  error,
  onSignIn,
  onSaveApiUrl,
}: SignInScreenProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    await onSignIn(email, password);
    setBusy(false);
  };

  return (
    <div className="popup__body" data-testid="sign-in-screen">
      <h1 className="popup__title">Sign in to Track Your Time</h1>

      {/* Two sibling forms, never nested: the API URL has its own submit and
          must stay usable while the sign-in form is in flight. */}
      <form className="form" onSubmit={submit} data-testid="sign-in-form">
        <div className="field">
          <label className="field__label" htmlFor="email">
            Email
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
            Password
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
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="notice" role="alert" aria-live="assertive" data-testid="sign-in-error">
        {error ?? ""}
      </p>

      <p className="popup__hint">
        The extension signs in against the server below. Fix the URL first if
        it cannot be reached.
      </p>

      <ApiUrlEditor apiUrl={apiUrl} onSave={onSaveApiUrl} />
    </div>
  );
}
