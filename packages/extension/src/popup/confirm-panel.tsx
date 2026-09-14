import type { JSX, KeyboardEvent } from "react";
import { useT } from "../i18n/use-t";

/**
 * A two-step confirm, inline.
 *
 * Never `window.confirm`: a native modal opened from a Chrome popup steals
 * focus from the popup, and losing focus is what destroys the popup — so the
 * dialog can outlive the thing that asked the question. Never a second route
 * either: a confirmation is not a place, and pushing one would put a back
 * button on a question whose two answers are already on screen.
 */

export type ConfirmPanelProps = {
  title: string;
  /** What is about to happen, or which row this is about. */
  hint?: string;
  confirmLabel: string;
  /** Destructive confirms get the danger button; the rest get the primary one. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
};

export function ConfirmPanel({
  title,
  hint,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  testId,
}: ConfirmPanelProps): JSX.Element {
  const t = useT("popup");
  // Escape cancels the question rather than leaving the screen. Marking the
  // event handled is what the screen's own Escape handler reads to stay put.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  };

  return (
    <div className="panel" onKeyDown={onKeyDown} data-testid={testId}>
      <p className="panel__title">{title}</p>
      {hint !== undefined ? <p className="panel__hint">{hint}</p> : null}

      <div className="panel__actions">
        <button
          className="button"
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid={`${testId}-cancel`}
        >
          {t("actions.cancel")}
        </button>
        <button
          className={danger ? "button button--danger" : "button button--primary"}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid={`${testId}-confirm`}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
