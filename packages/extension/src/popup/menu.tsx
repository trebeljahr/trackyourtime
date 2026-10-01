import { useEffect, useRef, useState, type JSX } from "react";
import { useT } from "../i18n/use-t";
import { join, openTab } from "./open-tab";

export type MenuProps = {
  /** Web app origin, discovered from the API. */
  webUrl: string | null;
  onSignOut?: () => Promise<boolean>;
  sharedSession?: boolean;
};

export function Menu({
  webUrl,
  onSignOut,
  sharedSession = false,
}: MenuProps): JSX.Element {
  const t = useT("popup");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("menu.more")}
        onClick={() => setOpen((current) => !current)}
        data-testid="menu-trigger"
      >
        ⋯
      </button>

      {open && (
        <div className="menu__list" role="menu" data-testid="menu-list">
          {webUrl !== null && (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => openTab(join(webUrl, "/app/track"))}
                data-testid="menu-open-app"
              >
                {t("actions.openApp")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => openTab(join(webUrl, "/app/reports"))}
                data-testid="menu-reports"
              >
                {t("menu.reports")}
              </button>
            </>
          )}
          {onSignOut && (
            <>
              {sharedSession && (
                <p className="popup__hint menu__note">
                  {t("account.signOutSharedHint")}
                </p>
              )}
              <button
                type="button"
                role="menuitem"
                className="menu__item menu__item--danger"
                disabled={busy}
                data-testid="menu-sign-out"
                onClick={() => {
                  setBusy(true);
                  void onSignOut().finally(() => setBusy(false));
                }}
              >
                {t("actions.signOut")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
