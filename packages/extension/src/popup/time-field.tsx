import { useState, type JSX } from "react";
import {
  formatClockInZone,
  parseTimeOfDayInZone,
  type TimeFormat,
} from "@starter/core";
import { useT } from "../i18n/use-t";

/**
 * A clock time, typed as text.
 *
 * Never `<input type="time">`. Chrome anchors that control's native overlay to
 * the input and clips it against a 380×580 extension popup rather than letting
 * it escape, it forces a locale-driven clock that ignores the user's own
 * `timeFormat`, and it renders nothing like the rest of `.input`. A text field
 * parsed by `parseTimeOfDayInZone` accepts everything the native one would —
 * `9`, `930`, `9:30`, `9:30 pm`, `21:30` — and answers in the entry's own zone.
 *
 * The zone is the whole point of taking one: typing `23:30` on an entry
 * recorded in Berlin means 23:30 Berlin, even when the person editing is in
 * Tokyo. Anchoring to the value being edited is what keeps the calendar day
 * fixed while only the clock reading moves.
 */

export type TimeFieldProps = {
  label: string;
  /** The instant being edited, ISO. Also the day and zone anchor. */
  value: string;
  /** IANA zone the reading is written in — the entry's, not this device's. */
  zone: string;
  timeFormat: TimeFormat;
  /** Called only when the parsed instant actually differs from `value`. */
  onCommit: (iso: string) => void;
  disabled?: boolean;
  testId: string;
};

export function TimeField({
  label,
  value,
  zone,
  timeFormat,
  onCommit,
  disabled = false,
  testId,
}: TimeFieldProps): JSX.Element {
  const t = useT("popup");
  const shown = formatClockInZone(value, zone, timeFormat);
  const [draft, setDraft] = useState(shown);
  const [rejected, setRejected] = useState(false);

  // Re-seeded during render rather than in an effect, the same rule the
  // tracker's fields follow: the field has to be right on the first paint
  // after a commit elsewhere in the form moved this instant.
  const [lastShown, setLastShown] = useState(shown);
  if (lastShown !== shown) {
    setLastShown(shown);
    setDraft(shown);
    setRejected(false);
  }

  const revert = (): void => {
    setDraft(shown);
    setRejected(false);
  };

  /**
   * Unparseable input reverts and says so in one line. It deliberately never
   * reaches the screen's error banner: a typo is not a failed action, and
   * putting it there would displace the message from whatever the user
   * actually did last.
   */
  const commit = (): void => {
    const parsed = parseTimeOfDayInZone(draft, value, zone);
    if (parsed === null) {
      setDraft(shown);
      setRejected(true);
      return;
    }
    setRejected(false);
    setDraft(formatClockInZone(parsed, zone, timeFormat));
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="range__field">
      <label className="field__label" htmlFor={`${testId}-input`}>
        {label}
      </label>
      <input
        id={`${testId}-input`}
        className="input input--time"
        type="text"
        // Numeric on a phone-shaped keyboard, still free text everywhere else:
        // "9:30 pm" has to remain typeable.
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            // Handled here so the screen's own Escape does not read a field
            // revert as "go back".
            event.preventDefault();
            revert();
            event.currentTarget.blur();
          }
        }}
        data-testid={testId}
      />
      {rejected ? (
        <p className="detail__note" data-testid={`${testId}-hint`}>
          {t("timeField.rejected")}
        </p>
      ) : null}
    </div>
  );
}
