"use client";

import * as React from "react";
import {
  IDLE_BEHAVIORS,
  MAX_IDLE_THRESHOLD_MINUTES,
  MIN_IDLE_THRESHOLD_MINUTES,
  type IdleBehavior,
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

export type IdleSettingsPanelProps = {
  controller: WorkspaceSettingsController;
};

/**
 * What happens when a device notices nobody is at it.
 *
 * The copy carries two warnings on purpose. Two of the four behaviours shorten
 * the running entry without asking, and detection is per-device while the timer
 * is not — both are surprising enough that finding out by losing an afternoon
 * would be the wrong way to learn them.
 */
export function IdleSettingsPanel({
  controller,
}: IdleSettingsPanelProps): React.JSX.Element {
  const { settings, saveState, save } = controller;
  const idle = settings.idle;
  const t = useT("settings");
  const tc = useT("common");

  // Labels live in the settings catalog rather than @starter/shared's English
  // `idleBehaviorLabel`, which Raycast keeps using.
  const behaviorOptions = IDLE_BEHAVIORS.map((behavior) => ({
    value: behavior,
    label: t(`idle.behaviors.${behavior}.label`),
    testId: `idle-behavior-${behavior}`,
  }));

  return (
    <Card data-testid="settings-idle">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("idle.title")}</CardTitle>
          <CardDescription>{t("idle.description")}</CardDescription>
        </div>
        <SaveIndicator state={saveState} testId="idle-save-indicator" />
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        <SettingRow
          title={t("idle.enabled.title")}
          description={t("idle.enabled.description")}
          testId="setting-idle-enabled"
        >
          <Switch
            checked={idle.enabled}
            onCheckedChange={(enabled) => save({ idle: { enabled } })}
            aria-label={t("idle.enabled.title")}
            data-testid="idle-enabled"
          />
        </SettingRow>

        <SettingRow
          title={t("idle.threshold.title")}
          htmlFor="idle-threshold"
          description={t("idle.threshold.description")}
          testId="setting-idle-threshold"
        >
          <NumberField
            id="idle-threshold"
            value={idle.thresholdMinutes}
            onCommit={(thresholdMinutes) => save({ idle: { thresholdMinutes } })}
            min={MIN_IDLE_THRESHOLD_MINUTES}
            max={MAX_IDLE_THRESHOLD_MINUTES}
            suffix={tc("units.minute")}
            disabled={!idle.enabled}
            testId="idle-threshold"
            aria-label={t("idle.threshold.ariaLabel")}
          />
        </SettingRow>

        <SettingRow
          title={t("idle.behavior.title")}
          description={t(`idle.behaviors.${idle.behavior}.description`)}
          testId="setting-idle-behavior"
        >
          <OptionGroup
            label={t("idle.behavior.title")}
            className="flex-wrap"
            value={idle.behavior}
            options={behaviorOptions}
            disabled={!idle.enabled}
            onChange={(behavior: IdleBehavior) => save({ idle: { behavior } })}
          />
        </SettingRow>

        <SettingRow
          title={t("idle.lock.title")}
          description={t("idle.lock.description")}
          testId="setting-idle-lock"
        >
          <Switch
            checked={idle.lockIsImmediate}
            onCheckedChange={(lockIsImmediate) =>
              save({ idle: { lockIsImmediate } })
            }
            disabled={!idle.enabled}
            aria-label={t("idle.lock.title")}
            data-testid="idle-lock-immediate"
          />
        </SettingRow>

        <SettingRow
          title={t("idle.projects.title")}
          description={t("idle.projects.description")}
          testId="setting-idle-projects"
        >
          <span className="text-sm text-muted-foreground">
            {t("idle.projects.location")}
          </span>
        </SettingRow>
      </CardContent>
    </Card>
  );
}
