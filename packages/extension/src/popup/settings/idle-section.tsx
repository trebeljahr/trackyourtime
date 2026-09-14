import type { JSX } from "react";
import {
  IDLE_BEHAVIORS,
  MAX_IDLE_THRESHOLD_MINUTES,
  MIN_IDLE_THRESHOLD_MINUTES,
  type IdleBehavior,
  type ResolvedSettings,
} from "@starter/core";
import type { SettingsPatch } from "../../lib/messaging";
import { NumberField } from "../number-field";
import { Switch } from "../switch";
import { SettingRow } from "../accordion";
import { useT, type PopupT } from "../../i18n/use-t";

/**
 * Idle detection, changed from the device that does the detecting.
 *
 * The labels and the sentence under the behaviour are the popup catalog's
 * `idleSettings.behaviors`, whose English is `@starter/shared`'s own
 * `idleBehaviorLabel` / `idleBehaviorDescription` word for word: the web app
 * renders the same four choices, and two copies of "what pause-and-resume does
 * to your entry" that disagree is how the surfaces end up promising different
 * things. Change them together.
 *
 * Changing anything in this block obliges the worker to re-run
 * `syncDetectionInterval()` — `chrome.idle`'s detection interval is set once
 * and sticks, so a threshold changed here would otherwise not take effect
 * until the worker was next evicted. That happens in `background/settings.ts`.
 */

export type IdleSectionProps = {
  settings: ResolvedSettings | null;
  onSave: (patch: SettingsPatch) => Promise<boolean>;
};

/**
 * The catalog's key for a behaviour. ICU `select` branches and catalog keys
 * are identifiers, so the hyphenated stored values are mapped rather than
 * used directly.
 */
const BEHAVIOR_KEY = {
  ask: "ask",
  "pause-and-resume": "pause",
  "keep-running": "keep",
  stop: "stop",
} as const satisfies Record<IdleBehavior, string>;

const behaviorLabel = (behavior: IdleBehavior, t: PopupT): string =>
  t(`idleSettings.behaviors.${BEHAVIOR_KEY[behavior]}.label`);

const behaviorDescription = (behavior: IdleBehavior, t: PopupT): string =>
  t(`idleSettings.behaviors.${BEHAVIOR_KEY[behavior]}.description`);

export function idleHint(settings: ResolvedSettings | null, t: PopupT): string {
  if (settings === null) return "…";
  const { idle } = settings;
  return idle.enabled
    ? t("idleSettings.hint", {
        behavior: BEHAVIOR_KEY[idle.behavior],
        minutes: idle.thresholdMinutes,
      })
    : t("settings.off");
}

export function IdleSection({ settings, onSave }: IdleSectionProps): JSX.Element {
  const t = useT("popup");
  if (settings === null) {
    return <p className="loading">{t("settings.loading")}</p>;
  }

  const { idle } = settings;
  const off = !idle.enabled;

  return (
    <>
      <SettingRow
        note={t("idleSettings.enabledNote")}
        testId="setting-idle-enabled"
      >
        <Switch
          checked={idle.enabled}
          onChange={(enabled) => {
            void onSave({ idle: { enabled } });
          }}
          label={idle.enabled ? t("idleSettings.on") : t("idleSettings.off")}
          testId="idle-enabled"
        />
      </SettingRow>

      <SettingRow
        label={t("idleSettings.threshold")}
        htmlFor="setting-idle-threshold"
        note={t("idleSettings.thresholdNote")}
        testId="setting-idle-threshold"
      >
        <NumberField
          id="setting-idle-threshold"
          value={idle.thresholdMinutes}
          onCommit={(thresholdMinutes) => {
            void onSave({ idle: { thresholdMinutes } });
          }}
          min={MIN_IDLE_THRESHOLD_MINUTES}
          max={MAX_IDLE_THRESHOLD_MINUTES}
          suffix={t("idleSettings.minutesSuffix")}
          disabled={off}
          ariaLabel={t("idleSettings.thresholdLabel")}
          testId="idle-threshold"
        />
      </SettingRow>

      <SettingRow
        label={t("idleSettings.behavior")}
        htmlFor="setting-idle-behavior"
        note={behaviorDescription(idle.behavior, t)}
        testId="setting-idle-behavior"
      >
        <select
          id="setting-idle-behavior"
          className="select"
          value={idle.behavior}
          disabled={off}
          onChange={(event) => {
            void onSave({ idle: { behavior: event.target.value as IdleBehavior } });
          }}
          data-testid="idle-behavior-select"
        >
          {IDLE_BEHAVIORS.map((behavior) => (
            <option key={behavior} value={behavior}>
              {behaviorLabel(behavior, t)}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        note={t("idleSettings.lockNote")}
        testId="setting-idle-lock"
      >
        <Switch
          checked={idle.lockIsImmediate}
          onChange={(lockIsImmediate) => {
            void onSave({ idle: { lockIsImmediate } });
          }}
          label={
            idle.lockIsImmediate
              ? t("idleSettings.lockImmediate")
              : t("idleSettings.lockWaits")
          }
          disabled={off}
          testId="idle-lock-immediate"
        />
      </SettingRow>
    </>
  );
}
