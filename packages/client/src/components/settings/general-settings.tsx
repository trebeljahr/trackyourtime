"use client";

import * as React from "react";
import { Laptop, Moon, Sun } from "lucide-react";
import type { DurationFormat, TimeFormat, WeekStart } from "@starter/shared";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LanguagePicker } from "@/components/settings/language-picker";
import { OptionGroup, type Option } from "@/components/settings/option-group";
import { SaveIndicator, SettingRow } from "@/components/settings/setting-row";
import type { WorkspaceSettingsController } from "@/components/settings/use-workspace-settings";
import { useTheme, type ThemeChoice } from "@/components/theme-toggle";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";

export type GeneralSettingsProps = {
  controller: WorkspaceSettingsController;
};

/** The sample every duration example renders: an hour and a half. */
const SAMPLE_DURATION_SEC = 5400;

/** Appearance and display preferences. Every control saves on change. */
export function GeneralSettings({
  controller,
}: GeneralSettingsProps): React.JSX.Element {
  const { settings, saveState, save } = controller;
  const { theme, setTheme } = useTheme();
  const t = useT("settings");
  const f = useFormat();

  const sampleClock = React.useMemo(() => {
    const sample = new Date();
    sample.setHours(14, 5, 0, 0);
    return f.time(sample, settings.timeFormat);
  }, [f, settings.timeFormat]);

  const themeOptions: Option<ThemeChoice>[] = [
    { value: "light", label: t("general.theme.light"), icon: Sun, testId: "theme-light" },
    { value: "dark", label: t("general.theme.dark"), icon: Moon, testId: "theme-dark" },
    { value: "system", label: t("general.theme.system"), icon: Laptop, testId: "theme-system" },
  ];

  const weekStartOptions: Option<"0" | "1">[] = [
    { value: "1", label: f.weekday(1, "long"), testId: "week-start-1" },
    { value: "0", label: f.weekday(0, "long"), testId: "week-start-0" },
  ];

  const timeFormatOptions: Option<TimeFormat>[] = [
    { value: "24h", label: t("general.timeFormat.hour24"), testId: "time-format-24h" },
    { value: "12h", label: t("general.timeFormat.hour12"), testId: "time-format-12h" },
  ];

  const durationFormatOptions: Option<DurationFormat>[] = [
    {
      value: "hms",
      label: f.duration(SAMPLE_DURATION_SEC, "hms"),
      testId: "duration-format-hms",
    },
    {
      value: "decimal",
      label: f.duration(SAMPLE_DURATION_SEC, "decimal"),
      testId: "duration-format-decimal",
    },
  ];

  return (
    <Card data-testid="settings-general">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("general.title")}</CardTitle>
          <CardDescription>{t("general.description")}</CardDescription>
        </div>
        <SaveIndicator state={saveState} testId="general-save-indicator" />
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        <SettingRow
          title={t("general.theme.title")}
          description={t("general.theme.description")}
          testId="setting-theme"
        >
          <OptionGroup
            label={t("general.theme.title")}
            value={theme}
            options={themeOptions}
            onChange={setTheme}
          />
        </SettingRow>

        <LanguagePicker />

        <SettingRow
          title={t("general.weekStart.title")}
          description={t("general.weekStart.description")}
          testId="setting-week-start"
        >
          <OptionGroup
            label={t("general.weekStart.title")}
            value={settings.weekStartsOn === 0 ? "0" : "1"}
            options={weekStartOptions}
            onChange={(value) => {
              const weekStartsOn: WeekStart = value === "0" ? 0 : 1;
              save({ weekStartsOn });
            }}
          />
        </SettingRow>

        <SettingRow
          title={t("general.timeFormat.title")}
          description={t("general.timeFormat.description", { sample: sampleClock })}
          testId="setting-time-format"
        >
          <OptionGroup
            label={t("general.timeFormat.title")}
            value={settings.timeFormat}
            options={timeFormatOptions}
            onChange={(timeFormat) => save({ timeFormat })}
          />
        </SettingRow>

        <SettingRow
          title={t("general.durationFormat.title")}
          description={t("general.durationFormat.description", {
            sample: f.duration(SAMPLE_DURATION_SEC, settings.durationFormat),
          })}
          testId="setting-duration-format"
        >
          <OptionGroup
            label={t("general.durationFormat.title")}
            value={settings.durationFormat}
            options={durationFormatOptions}
            onChange={(durationFormat) => save({ durationFormat })}
          />
        </SettingRow>
      </CardContent>
    </Card>
  );
}
