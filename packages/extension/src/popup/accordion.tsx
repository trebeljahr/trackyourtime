import { useId, type JSX, type ReactNode } from "react";
import { useT } from "../i18n/use-t";

/**
 * One collapsible settings section, and the row primitive its controls sit in.
 *
 * Single-open, and closed headers carry the section's current value. That
 * combination is what makes six panels fit a 560px window without a tab bar:
 * reading any setting is zero clicks, changing one is two, and only one
 * section's worth of controls is ever competing for the scroll.
 *
 * Which section is open is NOT held here. It lives on the route, because a
 * section that collapsed itself every time the three-second poll delivered a
 * fresh snapshot would be unusable.
 */

export type SectionProps = {
  title: string;
  /** The current value, summarised. Shown only while the section is closed. */
  hint: string;
  open: boolean;
  onToggle: () => void;
  /** Flashed after a successful write, in place of the hint. */
  saved: boolean;
  testId: string;
  children: ReactNode;
};

export function Section({
  title,
  hint,
  open,
  onToggle,
  saved,
  testId,
  children,
}: SectionProps): JSX.Element {
  const t = useT("popup");
  const bodyId = useId();

  return (
    <div className="section" data-testid={testId}>
      <button
        type="button"
        className="section__header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        data-testid={`${testId}-header`}
      >
        <span aria-hidden="true" className="section__caret">
          {open ? "▾" : "▸"}
        </span>
        <span className="section__title">{title}</span>
        {saved ? (
          <span className="section__saved" role="status">
            {t("section.saved")}
          </span>
        ) : open ? null : (
          <span className="section__hint">{hint}</span>
        )}
      </button>

      {open ? (
        <div className="section__body" id={bodyId} data-testid={`${testId}-body`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export type SettingRowProps = {
  /** Omitted for controls that carry their own text, like a {@link Switch}. */
  label?: string;
  /** The id of the control the label points at. */
  htmlFor?: string;
  /** One sentence about what the setting does, or who it applies to. */
  note?: string;
  testId?: string;
  children: ReactNode;
};

/**
 * Label above control, never beside it. At 380px a two-column row would give
 * the label about nine characters, and the settings that need explaining are
 * exactly the ones whose names do not fit in nine characters.
 */
export function SettingRow({
  label,
  htmlFor,
  note,
  testId,
  children,
}: SettingRowProps): JSX.Element {
  return (
    <div className="setting" data-testid={testId}>
      {label !== undefined ? (
        <label className="setting__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      <div className="setting__control">{children}</div>
      {note !== undefined ? <p className="setting__note">{note}</p> : null}
    </div>
  );
}
