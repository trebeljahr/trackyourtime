import type { JSX } from "react";
import { addDaysToKey, dayKeyInZone, type DayKey } from "@starter/core";
import { usePopupLocale, useT } from "../i18n/use-t";
import { entryDayLabel } from "./entry-format";

/**
 * Which calendar day an entry belongs to, as two arrows and a label.
 *
 * Never `<input type="date">`, for the reason {@link ./time-field} gives about
 * `type="time"`: Chrome's date picker is an overlay anchored to the input, and
 * inside a 380×580 popup it clips against the window instead of escaping it.
 * Two arrows also fit what this is actually used for — a manual entry is
 * almost always today or yesterday, and a calendar to reach yesterday is three
 * interactions where this is one.
 *
 * The days are counted in the entry's own zone, so stepping a Berlin entry back
 * from Tokyo moves it one Berlin day rather than landing mid-afternoon.
 */

export type DayStepperProps = {
  /** The instant whose calendar day is being moved, ISO. */
  value: string;
  zone: string;
  onChange: (dayKey: DayKey) => void;
  disabled?: boolean;
  testId: string;
};

export function DayStepper({
  value,
  zone,
  onChange,
  disabled = false,
  testId,
}: DayStepperProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const ms = Date.parse(value);
  const dayKey = dayKeyInZone(Number.isNaN(ms) ? Date.now() : ms, zone);
  const todayKey = dayKeyInZone(Date.now(), zone);

  // Forward stops at today. An entry is a record of work that happened, and a
  // popup with no calendar has no business scheduling one.
  const atToday = dayKey >= todayKey;

  return (
    <div className="field">
      <span className="field__label">{t("fields.day")}</span>
      <div className="daystep" data-testid={testId}>
        <button
          type="button"
          className="daystep__button"
          aria-label={t("dayStepper.previous")}
          disabled={disabled}
          onClick={() => onChange(addDaysToKey(dayKey, -1))}
          data-testid={`${testId}-prev`}
        >
          ‹
        </button>

        <span className="daystep__label" data-testid={`${testId}-label`}>
          {entryDayLabel(dayKey, todayKey, t, locale)}
        </span>

        <button
          type="button"
          className="daystep__button"
          aria-label={t("dayStepper.next")}
          disabled={disabled || atToday}
          onClick={() => onChange(addDaysToKey(dayKey, 1))}
          data-testid={`${testId}-next`}
        >
          ›
        </button>

        <button
          type="button"
          className="button"
          disabled={disabled || atToday}
          onClick={() => onChange(todayKey)}
          data-testid={`${testId}-today`}
        >
          {t("dayStepper.today")}
        </button>
      </div>
    </div>
  );
}
