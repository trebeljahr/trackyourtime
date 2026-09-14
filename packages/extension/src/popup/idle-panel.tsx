import type { JSX } from "react";
import type { IdleAnswer, PendingIdle } from "@starter/core";
import { formatIdleSpanFor } from "../i18n/format";
import { usePopupLocale, useT } from "../i18n/use-t";

export type IdlePanelProps = {
  pending: PendingIdle;
  busy: boolean;
  onAnswer: (answer: IdleAnswer) => void;
};

/**
 * The idle question, asked in the popup.
 *
 * The service worker detected the idleness and then did nothing — it has no UI
 * to ask in, and acting without asking is precisely what the `ask` behaviour
 * exists to avoid. So the timer kept running and the question waited here for
 * the next time the toolbar was opened. Nothing has been discarded yet, which
 * is why the copy says "still running" rather than reporting a change.
 */
export function IdlePanel({
  pending,
  busy,
  onAnswer,
}: IdlePanelProps): JSX.Element {
  const t = useT("popup");
  const span = formatIdleSpanFor(pending.idleSec, usePopupLocale());

  return (
    <div className="panel" data-testid="idle-panel">
      <p className="panel__title">
        {pending.signal === "locked"
          ? t("idle.lockedTitle", { span })
          : t("idle.inputTitle", { span })}
      </p>
      <p className="panel__hint">
        {t("idle.hint")}
      </p>

      <div className="panel__actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => onAnswer("keep")}
          data-testid="idle-keep"
        >
          {t("idle.keep")}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => onAnswer("discard")}
          data-testid="idle-discard"
        >
          {t("idle.discard", { span })}
        </button>
        <button
          className="button button--primary"
          type="button"
          disabled={busy}
          onClick={() => onAnswer("discard-and-resume")}
          data-testid="idle-discard-resume"
        >
          {t("idle.discardAndResume")}
        </button>
      </div>
    </div>
  );
}
