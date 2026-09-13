"use client";

import * as React from "react";
import { Laptop, Moon, Sun } from "lucide-react";
import {
  formatDuration,
  type DurationFormat,
  type TimeFormat,
  type WeekStart,
} from "@starter/shared";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OptionGroup } from "@/components/settings/option-group";
import { SaveIndicator, SettingRow } from "@/components/settings/setting-row";
import type { WorkspaceSettingsController } from "@/components/settings/use-workspace-settings";
import { useTheme, type ThemeChoice } from "@/components/theme-toggle";

export type GeneralSettingsProps = {
  controller: WorkspaceSettingsController;
};

const THEME_OPTIONS = [
  { value: "light" as ThemeChoice, label: "Light", icon: Sun, testId: "theme-light" },
  { value: "dark" as ThemeChoice, label: "Dark", icon: Moon, testId: "theme-dark" },
  {
    value: "system" as ThemeChoice,
    label: "System",
    icon: Laptop,
    testId: "theme-system",
  },
];

const WEEK_START_OPTIONS = [
  { value: "1" as const, label: "Monday", testId: "week-start-1" },
  { value: "0" as const, label: "Sunday", testId: "week-start-0" },
];

const TIME_FORMAT_OPTIONS = [
  { value: "24h" as TimeFormat, label: "24-hour", testId: "time-format-24h" },
  { value: "12h" as TimeFormat, label: "12-hour", testId: "time-format-12h" },
];

const DURATION_FORMAT_OPTIONS = [
  { value: "hms" as DurationFormat, label: "1:30:00", testId: "duration-format-hms" },
  {
    value: "decimal" as DurationFormat,
    label: "1.50 h",
    testId: "duration-format-decimal",
  },
];

/** Appearance and display preferences. Every control saves on change. */
export function GeneralSettings({
  controller,
}: GeneralSettingsProps): React.JSX.Element {
  const { settings, saveState, save } = controller;
  const { theme, setTheme } = useTheme();

  const sampleClock = React.useMemo(() => {
    const sample = new Date();
    sample.setHours(14, 5, 0, 0);
    return sample.toLocaleTimeString(undefined, {
      hour: settings.timeFormat === "12h" ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12: settings.timeFormat === "12h",
    });
  }, [settings.timeFormat]);

  return (
    <Card data-testid="settings-general">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>General</CardTitle>
          <CardDescription>
            How Track Your Time looks and how it prints dates and durations.
          </CardDescription>
        </div>
        <SaveIndicator state={saveState} testId="general-save-indicator" />
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        <SettingRow
          title="Theme"
          description="Saved to your account, so the browser extension and your other machines follow it."
          testId="setting-theme"
        >
          <OptionGroup
            label="Theme"
            value={theme}
            options={THEME_OPTIONS}
            onChange={setTheme}
          />
        </SettingRow>

        <SettingRow
          title="Week starts on"
          description="Sets the first column of the weekly timesheet and the “This week” range."
          testId="setting-week-start"
        >
          <OptionGroup
            label="Week starts on"
            value={settings.weekStartsOn === 0 ? "0" : "1"}
            options={WEEK_START_OPTIONS}
            onChange={(value) => {
              const weekStartsOn: WeekStart = value === "0" ? 0 : 1;
              save({ weekStartsOn });
            }}
          />
        </SettingRow>

        <SettingRow
          title="Time format"
          description={`Clock times render as ${sampleClock}.`}
          testId="setting-time-format"
        >
          <OptionGroup
            label="Time format"
            value={settings.timeFormat}
            options={TIME_FORMAT_OPTIONS}
            onChange={(timeFormat) => save({ timeFormat })}
          />
        </SettingRow>

        <SettingRow
          title="Duration format"
          description={`Durations render as ${formatDuration(5400, settings.durationFormat)}. Decimal hours are what most invoices expect.`}
          testId="setting-duration-format"
        >
          <OptionGroup
            label="Duration format"
            value={settings.durationFormat}
            options={DURATION_FORMAT_OPTIONS}
            onChange={(durationFormat) => save({ durationFormat })}
          />
        </SettingRow>
      </CardContent>
    </Card>
  );
}
