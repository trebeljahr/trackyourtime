import { useState, type JSX } from "react";
import { DEFAULT_API_URL } from "../../lib/config";
import type { SessionSource } from "../../lib/messaging";
import { describeServer } from "../../lib/server-label";
import { ConfirmPanel } from "../confirm-panel";
import { ServerPicker } from "../server-picker";
import type { SetServerOutcome } from "../switch-server";
import { join, openTab } from "../open-tab";
import { useT, type PopupT } from "../../i18n/use-t";

/**
 * Who is signed in, where the server is, and the way out.
 *
 * There is deliberately no "Delete account" row: no procedure exists for it,
 * and building a button that cannot do what it says is worse than not offering
 * it. Nothing about subscriptions either — billing is a web-app surface.
 *
 * "Change server…" lives here rather than in the overflow menu because this is
 * where someone looks when the popup cannot reach the server, and it is the
 * one control that can fix that. The picker is dropped in unchanged as a
 * SIBLING form, never nested inside another one.
 */

export type AccountSectionProps = {
  email: string | null;
  sessionSource: SessionSource | null;
  webUrl: string | null;
  apiUrl: string;
  /** "Track Your Time 0.1.0 (1a2b3c4)", when the server has said. */
  serverVersion: string | null;
  /** Queued changes a server switch would discard. */
  pendingSync: number;
  onSetServer: (
    origin: string,
    discardUnsent: boolean,
  ) => Promise<SetServerOutcome>;
  onSignOut: () => Promise<boolean>;
};

export function accountHint(email: string | null, t: PopupT): string {
  return email ?? t("app.signedIn");
}

export function AccountSection({
  email,
  sessionSource,
  webUrl,
  apiUrl,
  serverVersion,
  pendingSync,
  onSetServer,
  onSignOut,
}: AccountSectionProps): JSX.Element {
  const t = useT("popup");
  const [showServer, setShowServer] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const shared = sessionSource === "web";

  return (
    <>
      {/* Not a SettingRow: there is no control here for a <label> to point
          at, and a label with nothing to name is a screen-reader dead end. */}
      <div className="setting" data-testid="setting-account-email">
        <span className="setting__label">{t("account.signedInAs")}</span>
        <span className="footer__email" title={email ?? ""}>
          {email ?? t("app.signedIn")}
        </span>
      </div>

      {shared ? (
        <p className="setting__note" data-testid="account-shared-session">
          {t("account.sharedSession")}
        </p>
      ) : null}

      {webUrl !== null ? (
        <button
          type="button"
          className="button button--block"
          onClick={() => openTab(join(webUrl, "/track"))}
          data-testid="account-open-app"
        >
          {t("actions.openAppExternal")}
        </button>
      ) : null}

      <div className="setting" data-testid="setting-account-server">
        <span className="setting__label">{t("server.label")}</span>
        <span className="footer__email" title={apiUrl}>
          {describeServer(apiUrl, DEFAULT_API_URL, t)}
        </span>
        {serverVersion !== null ? (
          <span className="setting__note" data-testid="account-server-version">
            {serverVersion}
          </span>
        ) : null}
      </div>

      <button
        type="button"
        className="button--link"
        aria-expanded={showServer}
        onClick={() => setShowServer((open) => !open)}
        data-testid="account-api-url-toggle"
      >
        {showServer ? t("account.keepServer") : t("account.changeServer")}
      </button>

      {showServer ? (
        <ServerPicker
          apiUrl={apiUrl}
          pendingSync={pendingSync}
          onSetServer={onSetServer}
          onSwitched={() => setShowServer(false)}
        />
      ) : null}

      {confirming ? (
        <ConfirmPanel
          title={t("account.signOutTitle")}
          hint={shared ? t("account.signOutSharedHint") : t("account.signOutHint")}
          confirmLabel={t("actions.signOut")}
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
          {t("actions.signOut")}
        </button>
      )}
    </>
  );
}
