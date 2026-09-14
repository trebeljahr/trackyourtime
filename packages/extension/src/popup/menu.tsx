import { useEffect, useRef, useState, type JSX } from "react";
import { useT } from "../i18n/use-t";
import { join, openTab } from "./open-tab";

/**
 * The way out to the web app, and nothing else any more.
 *
 * Settings, the API URL and signing out used to live here because the popup
 * could not express them; they are now behind the cog, in the popup itself.
 * What is left is the surfaces that genuinely need width the popup does not
 * have — reports and the calendar — so every item here is a link out, and the
 * menu is not rendered at all when the web app's origin is unknown.
 */

export type MenuProps = {
  /** Web app origin, discovered from the API. */
  webUrl: string;
};

export function Menu({ webUrl }: MenuProps): JSX.Element {
  const t = useT("popup");
  const [open, setOpen] = useState(false);
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
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => openTab(join(webUrl, "/track"))}
            data-testid="menu-open-app"
          >
            {t("actions.openApp")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => openTab(join(webUrl, "/reports"))}
            data-testid="menu-reports"
          >
            {t("menu.reports")}
          </button>
        </div>
      )}
    </div>
  );
}
