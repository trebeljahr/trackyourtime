import { useState, type JSX } from "react";
import type { SessionSource } from "../../lib/messaging";
import { ApiUrlEditor } from "../api-url-editor";
import { ConfirmPanel } from "../confirm-panel";
import { join, openTab } from "../open-tab";

/**
 * Who is signed in, where the server is, and the way out.
 *
 * There is deliberately no "Delete account" row: no procedure exists for it,
 * and building a button that cannot do what it says is worse than not offering
 * it. Nothing about subscriptions either — billing is a web-app surface.
 *
 * "Change API URL…" lives here rather than in the overflow menu because this
 * is where someone looks when the popup cannot reach the server, and it is the
 * one control that can fix that. It is dropped in unchanged as a SIBLING form,
 * never nested inside another one.
 */

export type AccountSectionProps = {
  email: string | null;
  sessionSource: SessionSource | null;
  webUrl: string | null;
  apiUrl: string;
  onSaveApiUrl: (apiUrl: string) => Promise<boolean>;
  onSignOut: () => Promise<boolean>;
};

export function accountHint(email: string | null): string {
  return email ?? "Signed in";
}

export function AccountSection({
  email,
  sessionSource,
  webUrl,
  apiUrl,
  onSaveApiUrl,
  onSignOut,
}: AccountSectionProps): JSX.Element {
  const [showApiUrl, setShowApiUrl] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const shared = sessionSource === "web";

  return (
    <>
      {/* Not a SettingRow: there is no control here for a <label> to point
          at, and a label with nothing to name is a screen-reader dead end. */}
      <div className="setting" data-testid="setting-account-email">
        <span className="setting__label">Signed in as</span>
        <span className="footer__email" title={email ?? ""}>
          {email ?? "Signed in"}
        </span>
      </div>

      {shared ? (
        <p className="setting__note" data-testid="account-shared-session">
          Signed in with the web app’s session — signing out here signs out
          Track Your Time in this browser too.
        </p>
      ) : null}

      {webUrl !== null ? (
        <button
          type="button"
          className="button button--block"
          onClick={() => openTab(join(webUrl, "/track"))}
          data-testid="account-open-app"
        >
          Open Track Your Time ↗
        </button>
      ) : null}

      <button
        type="button"
        className="button--link"
        aria-expanded={showApiUrl}
        onClick={() => setShowApiUrl((open) => !open)}
        data-testid="account-api-url-toggle"
      >
        Change API URL…
      </button>

      {showApiUrl ? (
        <ApiUrlEditor apiUrl={apiUrl} onSave={onSaveApiUrl} />
      ) : null}

      {confirming ? (
        <ConfirmPanel
          title="Sign out?"
          hint={
            shared
              ? "This session is shared with the web app, so Track Your Time signs out in this browser too."
              : "Anything already tracked is kept. You sign in again to keep tracking."
          }
          confirmLabel="Sign out"
          danger
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            void (async (): Promise<void> => {
              if (busy) return;
              setBusy(true);
              await onSignOut();
              setBusy(false);
              setConfirming(false);
            })();
          }}
          testId="account-sign-out-confirm"
        />
      ) : (
        <button
          type="button"
          className="button button--danger button--block"
          onClick={() => setConfirming(true)}
          data-testid="account-sign-out"
        >
          Sign out
        </button>
      )}
    </>
  );
}
