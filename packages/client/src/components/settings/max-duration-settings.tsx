"use client";

import * as React from "react";
import {
  DEFAULT_MAX_DURATION_SETTINGS,
  MAX_MAX_DURATION_HOURS,
  MIN_MAX_DURATION_HOURS,
  RUNAWAY_BEHAVIORS,
  type RunawayBehavior,
} from "@starter/shared";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { NumberField } from "@/components/settings/number-field";
import { OptionGroup } from "@/components/settings/option-group";
import { SaveIndicator, SettingRow } from "@/components/settings/setting-row";
import type { WorkspaceSettingsController } from "@/components/settings/use-workspace-settings";
import { useT } from "@/i18n/use-t";

export type MaxDurationSettingsPanelProps = {
  controller: WorkspaceSettingsController;
};

/**
 * The runaway-timer guard.
 *
 * Sibling of the Idle panel, and the copy has to keep saying which is which:
 * idle is "you stopped typing" and needs a device awake to notice, this one is
 * "the laptop was shut all weekend" and is worked out on the server. People
 * who find one of them will look for the other here.
 */
export function MaxDurationSettingsPanel({
  controller,
}: MaxDurationSettingsPanelProps): React.JSX.Element {
  const { settings, saveState, save } = controller;
  const maxDuration = settings.maxDuration;
  const enabled = maxDuration.maxHours > 0;
  const t = useT("settings");
  const tc = useT("common");

  // Labels live in the settings catalog rather than @starter/shared's English
  // `runawayBehaviorLabel`, which Raycast keeps using.
  const behaviorOptions = RUNAWAY_BEHAVIORS.map((behavior) => ({
    value: behavior,
    label: t(`maxDuration.behaviors.${behavior}.label`),
    testId: `runaway-behavior-${behavior}`,
  }));

  // The switch and the field are two views of one number: 0 is off. Turning it
  // back on restores the shipped default rather than the last value, because
  // the last value is exactly the one the person had just decided against.
  const toggle = (next: boolean): void =>
    save({
      maxDuration: {
        maxHours: next ? DEFAULT_MAX_DURATION_SETTINGS.maxHours : 0,
      },
    });

  return (
    <Card data-testid="settings-max-duration">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("maxDuration.title")}</CardTitle>
          <CardDescription>{t("maxDuration.description")}</CardDescription>
        </div>
        <SaveIndicator state={saveState} testId="max-duration-save-indicator" />
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        <SettingRow
          title={t("maxDuration.enabled.title")}
          description={t("maxDuration.enabled.description")}
          testId="setting-max-duration-enabled"
        >
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            aria-label={t("maxDuration.enabled.title")}
            data-testid="max-duration-enabled"
          />
        </SettingRow>

        <SettingRow
          title={t("maxDuration.hours.title")}
          htmlFor="max-duration-hours"
          description={t("maxDuration.hours.description")}
          testId="setting-max-duration-hours"
        >
          <NumberField
            id="max-duration-hours"
            value={
              enabled
                ? maxDuration.maxHours
                : DEFAULT_MAX_DURATION_SETTINGS.maxHours
            }
            onCommit={(maxHours) => save({ maxDuration: { maxHours } })}
            min={MIN_MAX_DURATION_HOURS}
            max={MAX_MAX_DURATION_HOURS}
            suffix={tc("units.hour")}
            disabled={!enabled}
            testId="max-duration-hours"
            aria-label={t("maxDuration.hours.ariaLabel")}
          />
        </SettingRow>

        <SettingRow
          title={t("maxDuration.behavior.title")}
          description={t(`maxDuration.behaviors.${maxDuration.behavior}.description`)}
          testId="setting-max-duration-behavior"
        >
          <OptionGroup
            label={t("maxDuration.behavior.title")}
            className="flex-wrap"
            value={maxDuration.behavior}
            options={behaviorOptions}
            disabled={!enabled}
            onChange={(behavior: RunawayBehavior) =>
              save({ maxDuration: { behavior } })
            }
          />
        </SettingRow>

        <SettingRow
          title={t("maxDuration.undo.title")}
          description={t("maxDuration.undo.description")}
          testId="setting-max-duration-undo"
        >
          <span className="text-sm text-muted-foreground">
            {t("maxDuration.undo.always")}
          </span>
        </SettingRow>
      </CardContent>
    </Card>
  );
}
