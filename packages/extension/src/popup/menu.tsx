import { useEffect, useRef, useState, type JSX } from "react";
import { useT } from "../i18n/use-t";
import { ExternalLink } from "lucide-react";
import { join, openTab } from "./open-tab";

export type MenuProps = {
  /** Web app origin, discovered from the API. */
  webUrl: string | null;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  onOpenSettings?: () => void;
  onSignOut?: () => Promise<boolean>;
  sharedSession?: boolean;
};

export function Menu({
  webUrl,
  email,
  name,
  image,
  onOpenSettings,
  onSignOut,
  sharedSession = false,
}: MenuProps): JSX.Element {
  const t = useT("popup");
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const identity = name || email || t("app.signedIn");
  const initials = (name || email || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase();
  const external = <ExternalLink size={14} aria-hidden="true" />;
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
        aria-label={t("menu.account", { name: identity })}
        title={identity}
        onClick={() => setOpen((current) => !current)}
        data-testid="menu-trigger"
      >
        {image && image !== failedImage ? (
          <img className="menu__avatar" src={image} alt="" referrerPolicy="no-referrer" onError={() => setFailedImage(image)} />
        ) : <span className="menu__avatar menu__avatar--fallback" aria-hidden="true">{initials}</span>}
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
                title={t("menu.newTab")}
                aria-label={`${t("actions.openApp")} (${t("menu.newTab")})`}
                data-testid="menu-open-app"
              >
                {t("actions.openApp")} {external}
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => openTab(join(webUrl, "/app/reports"))}
                title={t("menu.newTab")}
                aria-label={`${t("menu.reports")} (${t("menu.newTab")})`}
                data-testid="menu-reports"
              >
                {t("menu.reports")} {external}
              </button>
            </>
          )}
          {onOpenSettings && (
            <button type="button" role="menuitem" className="menu__item"
              title={webUrl ? t("menu.newTab") : undefined}
              aria-label={webUrl ? `${t("header.settings")} (${t("menu.newTab")})` : t("header.settings")}
              data-testid="menu-settings" onClick={() => { setOpen(false); onOpenSettings(); }}>
              {t("header.settings")} {webUrl ? external : null}
            </button>
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
