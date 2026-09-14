import type { JSX } from "react";
import {
  DEFAULT_MAX_DURATION_SETTINGS,
  isRunawayGuardOn,
  MAX_MAX_DURATION_HOURS,
  MIN_MAX_DURATION_HOURS,
  RUNAWAY_BEHAVIORS,
  type ResolvedSettings,
  type RunawayBehavior,
} from "@starter/core";
import type { SettingsPatch } from "../../lib/messaging";
import { NumberField } from "../number-field";
import { Switch } from "../switch";
import { SettingRow } from "../accordion";
import { useT, type PopupT } from "../../i18n/use-t";

/**
 * The runaway-timer guard.
 *
 * There is no `enabled` flag anywhere in the model: `maxHours: 0` IS the off
 * switch, read back with `isRunawayGuardOn`. Two ways to disable one feature
 * would be two things to keep in step, and the number alone already answers
 * "after how long", including "never".
 *
 * The trap that follows from it: `maxHours` must never be tested for
 * truthiness, because 0 is both a legal value and the falsy one. Everything
 * here goes through `isRunawayGuardOn`, and the switch writes the default
 * back rather than a boolean.
 *
 * Evaluated on the server, not here — the case this guard exists for is the
 * Friday-evening timer found on Monday, where no client was running at all.
 */

export type LimitsSectionProps = {
  settings: ResolvedSettings | null;
  onSave: (patch: SettingsPatch) => Promise<boolean>;
};

/** What the number field shows while the guard is off, so it is not blank. */
const PLACEHOLDER_HOURS = DEFAULT_MAX_DURATION_SETTINGS.maxHours;

/**
 * The label and sentence for a behaviour, in the popup's language. The
 * English wording is `@starter/shared`'s `runawayBehaviorLabel` /
 * `runawayBehaviorDescription`, which the web app renders too — change both
 * together.
 */
const behaviorLabel = (behavior: RunawayBehavior, t: PopupT): string => {
  switch (behavior) {
    case "ask":
      return t("limits.behaviors.ask.label");
    case "cap":
      return t("limits.behaviors.cap.label");
    case "stop":
      return t("limits.behaviors.stop.label");
  }
};

const behaviorDescription = (behavior: RunawayBehavior, t: PopupT): string => {
  switch (behavior) {
    case "ask":
      return t("limits.behaviors.ask.description");
    case "cap":
      return t("limits.behaviors.cap.description");
    case "stop":
      return t("limits.behaviors.stop.description");
  }
};

export function limitsHint(settings: ResolvedSettings | null, t: PopupT): string {
  if (settings === null) return "…";
  const { maxDuration } = settings;
  return isRunawayGuardOn(maxDuration)
    ? t("limits.hint", { hours: maxDuration.maxHours, behavior: maxDuration.behavior })
    : t("settings.off");
}

export function LimitsSection({
  settings,
  onSave,
}: LimitsSectionProps): JSX.Element {
  const t = useT("popup");
  if (settings === null) {
    return <p className="loading">{t("settings.loading")}</p>;
  }

  const { maxDuration } = settings;
  const on = isRunawayGuardOn(maxDuration);

  return (
    <>
      <SettingRow
        note={t("limits.enabledNote")}
        testId="setting-limits-enabled"
      >
        <Switch
          checked={on}
          onChange={(next) => {
            void onSave({
              maxDuration: {
                maxHours: next ? DEFAULT_MAX_DURATION_SETTINGS.maxHours : 0,
              },
            });
          }}
          label={on ? t("limits.on") : t("limits.off")}
          testId="limits-enabled"
        />
      </SettingRow>

      <SettingRow
        label={t("limits.after")}
        htmlFor="setting-limits-hours"
        note={t("limits.afterNote")}
        testId="setting-limits-hours"
      >
        <NumberField
          id="setting-limits-hours"
          value={on ? maxDuration.maxHours : PLACEHOLDER_HOURS}
          onCommit={(maxHours) => {
            void onSave({ maxDuration: { maxHours } });
          }}
          min={MIN_MAX_DURATION_HOURS}
          max={MAX_MAX_DURATION_HOURS}
          suffix={t("limits.hoursSuffix")}
          disabled={!on}
          ariaLabel={t("limits.hoursLabel")}
          testId="limits-max-hours"
        />
      </SettingRow>

      <SettingRow
        label={t("limits.then")}
        htmlFor="setting-limits-behavior"
        note={behaviorDescription(maxDuration.behavior, t)}
        testId="setting-limits-behavior"
      >
        <select
          id="setting-limits-behavior"
          className="select"
          value={maxDuration.behavior}
          disabled={!on}
          onChange={(event) => {
            void onSave({
              maxDuration: { behavior: event.target.value as RunawayBehavior },
            });
          }}
          data-testid="limits-behavior-select"
        >
          {RUNAWAY_BEHAVIORS.map((behavior) => (
            <option key={behavior} value={behavior}>
              {behaviorLabel(behavior, t)}
            </option>
          ))}
        </select>
      </SettingRow>
    </>
  );
}
