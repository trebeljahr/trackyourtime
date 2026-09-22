import type { JSX } from "react";
import { useT } from "../i18n/use-t";
import { Icon } from "./icons";
import type { SyncLabel } from "./sync-label";

/**
 * The popup's only chrome.
 *
 * 44px with 32px buttons: the icons are the popup's whole navigation, and at
 * the old 14px glyphs they were hard to hit and harder to read. The tracker
 * still gets no title — the elapsed clock is the title.
 *
 * Nothing here opens a popover. The overflow menu's list opens *upward*
 * because it lives in the footer, and a header-anchored dropdown would need a
 * second flip case for no gain; the actions are all direct.
 */

export type HeaderProps = {
  /** Omitted on the tracker, where the clock below is the title. */
  title?: string;
  /** Omitted at depth 1, where there is nothing to go back to. */
  onBack?: () => void;
  /** Rendered only when supplied, so a screen opts into each action. */
  onOpenEntries?: () => void;
  onOpenSettings?: () => void;
  onNewEntry?: () => void;
  /** Only offered while activity capture is on — see the tracker. */
  onOpenSuggestions?: () => void;
  /**
   * A bare dot, never a label. The labelled status stays in the tracker's
   * footer, where there is room for the sentence that makes it useful.
   */
  sync?: SyncLabel;
};

export function Header({
  title,
  onBack,
  onOpenEntries,
  onOpenSettings,
  onNewEntry,
  onOpenSuggestions,
  sync,
}: HeaderProps): JSX.Element {
  const t = useT("popup");
  return (
    <div className="header">
      {onBack !== undefined ? (
        <button
          type="button"
          className="icon-button header__back"
          aria-label={t("header.back")}
          onClick={onBack}
          data-testid="header-back"
        >
          <Icon name="back" />
        </button>
      ) : null}

      {title !== undefined ? (
        <span className="header__title">{title}</span>
      ) : null}

      <div className="header__actions">
        {sync !== undefined ? (
          <span
            className={`status__dot status__dot--${sync.tone}`}
            title={sync.title}
            aria-label={sync.label}
            role="img"
            data-testid="header-sync-status"
          />
        ) : null}

        {onNewEntry !== undefined ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t("header.newEntry")}
            title={t("header.newEntry")}
            onClick={onNewEntry}
            data-testid="header-new-entry"
          >
            <Icon name="plus" />
          </button>
        ) : null}

        {onOpenSuggestions !== undefined ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t("header.suggestions")}
            title={t("header.suggestionsTitle")}
            onClick={onOpenSuggestions}
            data-testid="header-suggestions"
          >
            <Icon name="sparkles" />
          </button>
        ) : null}

        {onOpenEntries !== undefined ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t("header.entries")}
            title={t("header.entries")}
            onClick={onOpenEntries}
            data-testid="header-entries"
          >
            <Icon name="list" />
          </button>
        ) : null}

        {onOpenSettings !== undefined ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t("header.settings")}
            title={t("header.settings")}
            onClick={onOpenSettings}
            data-testid="header-settings"
          >
            <Icon name="settings" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
