import { useState, type JSX } from "react";

/**
 * A numeric field that commits on blur and Enter, never on a keystroke.
 *
 * The rule exists for one bug in particular: an hourly rate typed as "120"
 * passes through "1" and "12" on the way, and a field that saved as you typed
 * would write both. It matters more here than on the web, because every
 * settings control in this popup writes immediately and the server does
 * read-modify-write on the nested blocks — two racing partial patches to
 * `idle` can lose one.
 *
 * Escape reverts rather than committing, and an unchanged value sends nothing
 * at all, so tabbing across a settings section is silent.
 */

export type NumberFieldProps = {
  id?: string;
  value: number;
  /** Called only when the parsed, clamped value actually differs. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  /** `step < 1` keeps two decimals; otherwise the value is rounded to an int. */
  step?: number;
  /** Rendered beside the field, e.g. "min" or a currency code. */
  suffix?: string;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
};

const parseNumber = (raw: string): number | null => {
  // A comma is what a German keyboard produces for a decimal point. Accepted
  // in every language rather than only in German: the keyboard, not the
  // interface language, decides which key a person reaches for.
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export function NumberField({
  id,
  value,
  onCommit,
  min = 0,
  max,
  step = 1,
  suffix,
  disabled = false,
  testId,
  ariaLabel,
}: NumberFieldProps): JSX.Element {
  const [draft, setDraft] = useState(String(value));

  // Re-seed from the snapshot during render rather than in an effect, so the
  // field is right on the first paint after another client changed the value.
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(String(value));
  }

  const commit = (): void => {
    const parsed = parseNumber(draft);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    const upper = max ?? Number.MAX_SAFE_INTEGER;
    const clamped = Math.min(upper, Math.max(min, parsed));
    const next = step < 1 ? Math.round(clamped * 100) / 100 : Math.round(clamped);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <span className="number">
      <input
        id={id}
        className="input input--number"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            // Stopped here so the screen's own Escape handler does not read a
            // field revert as "go back".
            event.preventDefault();
            setDraft(String(value));
          }
        }}
        data-testid={testId}
      />
      {suffix !== undefined ? (
        <span className="number__suffix" aria-hidden="true">
          {suffix}
        </span>
      ) : null}
    </span>
  );
}
