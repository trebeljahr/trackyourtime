"use client";

import * as React from "react";
import { X } from "lucide-react";
import type {
  DesktopActivitySettings,
  DesktopActivitySnapshot,
  DesktopActivityUnavailableReason,
} from "@starter/shared";

import { ConfirmDialog } from "@/components/catalog/confirm-dialog";
import { NumberField } from "@/components/settings/number-field";
import { SettingRow } from "@/components/settings/setting-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useIsElectron } from "@/hooks/use-shell";
import { useT } from "@/i18n/use-t";
import { desktopActivity } from "@/lib/desktop-activity";

/** The same bounds main clamps to (`electron/src/activity/settings.ts`). */
export const MIN_ACTIVITY_RETENTION_DAYS = 1;
export const MAX_ACTIVITY_RETENTION_DAYS = 90;

/**
 * Reasons that are the channel or the OS session, not something that went
 * wrong while running: capture cannot be switched on at all. Main refuses
 * `enabled: true` for these too, so the disabled switch is not the only guard.
 * The runtime reasons (a missing tool, a policy, a helper that gave up) leave
 * the switch usable, because turning it off and on is how a retry happens.
 */
const CHANNEL_REASONS: ReadonlySet<DesktopActivityUnavailableReason> = new Set([
  "store",
  "linux-sandbox",
  "wayland",
  "unsupported-platform",
  "newer-format",
]);

export function captureSwitchable(snapshot: DesktopActivitySnapshot): boolean {
  return snapshot.support.supported || !CHANNEL_REASONS.has(snapshot.support.reason);
}

/**
 * Settings → Desktop → Activity capture: whether this computer records which
 * app is in front, for the suggestions on /app/activity.
 *
 * Off by default, and every value here is a device preference kept by the
 * main process in `userData/activity/`, never a synced setting. No OS
 * permission is asked for, on any system: the app reads only which app is in
 * front, which macOS, Windows and X11 all answer without a prompt. Window
 * titles are the app's own opt-in on Windows and Linux, and are not offered
 * on macOS (they would need Screen Recording).
 *
 * Rendered after hydration, and only when the preload has an activity
 * bridge, so the prerendered settings page never differs from the web's.
 */
export function DesktopActivityCard(): React.JSX.Element | null {
  const t = useT("settings");
  const electron = useIsElectron();
  const [snapshot, setSnapshot] = React.useState<DesktopActivitySnapshot | null>(null);
  const [pattern, setPattern] = React.useState("");
  const [confirmingWipe, setConfirmingWipe] = React.useState(false);
  const [wiped, setWiped] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!electron) return;
    const activity = desktopActivity();
    if (activity === null) return;
    let live = true;
    const off = activity.onChanged((next) => {
      if (live) setSnapshot(next);
    });
    activity.snapshot().then(
      (next) => {
        if (live) setSnapshot(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
      off();
    };
  }, [electron]);

  const update = React.useCallback(async (patch: Partial<DesktopActivitySettings>): Promise<boolean> => {
    const activity = desktopActivity();
    if (activity === null) return false;
    try {
      setSnapshot(await activity.updateSettings(patch));
      setFailed(false);
      setWiped(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, []);

  if (!electron || snapshot === null) return null;

  const { settings, support } = snapshot;
  const mac = typeof window !== "undefined" && window.electronAPI?.platform === "darwin";
  const switchable = captureSwitchable(snapshot);
  const on = settings.enabled && switchable;
  const names = new Map(snapshot.recentApps.map((app) => [app.key, app.name]));
  const suggestable = snapshot.recentApps.filter((app) => !settings.excludedApps.includes(app.key)).slice(0, 8);

  const addExclusion = (value: string): void => {
    const next = value.trim();
    if (next === "") return;
    void update({ excludedApps: [...settings.excludedApps, next] }).then((ok) => {
      if (ok) setPattern("");
    });
  };

  const status = ((): string => {
    if (!support.supported) {
      return support.reason === "tool-missing"
        ? t("desktop.activity.unavailable.tool-missing", { package: support.hint ?? "xprop" })
        : t(`desktop.activity.unavailable.${support.reason}`);
    }
    if (!settings.enabled) return t("desktop.activity.status.off");
    if (!snapshot.scoped) return t("desktop.activity.status.noScope");
    if (snapshot.paused === "locked") return t("desktop.activity.status.locked");
    if (snapshot.paused === "idle") return t("desktop.activity.status.idle");
    return t("desktop.activity.status.recording");
  })();

  const titlesNote = !snapshot.titlesAvailable
    ? mac
      ? t("desktop.activity.titles.notOnMac")
      : t("desktop.activity.titles.notHere")
    : t("desktop.activity.titles.description");

  return (
    <Card data-testid="settings-desktop-activity">
      <CardHeader>
        <CardTitle>{t("desktop.activity.title")}</CardTitle>
        <CardDescription>{t("desktop.activity.description")}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        <SettingRow
          title={t("desktop.activity.enabled.title")}
          description={
            <>
              {t("desktop.activity.enabled.description")}
              <span
                className={
                  support.supported ? "mt-2 block text-muted-foreground" : "mt-2 block text-destructive"
                }
                role="status"
                data-testid="desktop-activity-status"
                data-reason={support.supported ? "" : support.reason}
                data-recording={snapshot.recording ? "true" : "false"}
              >
                {status}
              </span>
            </>
          }
          testId="setting-desktop-activity-enabled"
        >
          <Switch
            checked={on}
            disabled={!switchable}
            onCheckedChange={(enabled) => void update({ enabled })}
            aria-label={t("desktop.activity.enabled.title")}
            data-testid="desktop-activity-enabled"
          />
        </SettingRow>

        <SettingRow
          title={t("desktop.activity.titles.title")}
          description={titlesNote}
          testId="setting-desktop-activity-titles"
        >
          <Switch
            checked={settings.storeTitles && snapshot.titlesAvailable}
            disabled={!on || !snapshot.titlesAvailable}
            onCheckedChange={(storeTitles) => void update({ storeTitles })}
            aria-label={t("desktop.activity.titles.title")}
            data-testid="desktop-activity-titles"
          />
        </SettingRow>

        <div className="space-y-3 py-4" data-testid="setting-desktop-activity-excluded">
          <div className="space-y-1">
            <label htmlFor="desktop-activity-exclude" className="text-sm font-medium leading-none">
              {t("desktop.activity.exclude.title")}
            </label>
            <p className="max-w-prose text-sm text-muted-foreground">{t("desktop.activity.exclude.description")}</p>
          </div>
          {settings.excludedApps.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {settings.excludedApps.map((key) => {
                const label = names.get(key) ?? key;
                return (
                  <li
                    key={key}
                    className="flex items-center gap-1 rounded-md border border-border py-0.5 pl-2 pr-0.5 text-sm"
                    data-testid="desktop-activity-excluded-app"
                    data-key={key}
                  >
                    <span className="max-w-60 truncate" title={key}>
                      {label}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => void update({ excludedApps: settings.excludedApps.filter((it) => it !== key) })}
                      aria-label={t("desktop.activity.exclude.remove", { app: label })}
                      data-testid={`desktop-activity-excluded-remove-${key}`}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {suggestable.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t("desktop.activity.exclude.recent")}</p>
              <div className="flex flex-wrap gap-2">
                {suggestable.map((app) => (
                  <Button
                    key={app.key}
                    variant="outline"
                    size="sm"
                    onClick={() => addExclusion(app.key)}
                    aria-label={t("desktop.activity.exclude.addApp", { app: app.name })}
                    data-testid="desktop-activity-exclude-recent"
                    data-key={app.key}
                  >
                    {app.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Input
              id="desktop-activity-exclude"
              value={pattern}
              placeholder="com.example.*"
              onChange={(event) => setPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addExclusion(pattern);
                }
              }}
              className="max-w-xs"
              data-testid="desktop-activity-exclude-input"
            />
            <Button
              variant="outline"
              disabled={pattern.trim() === ""}
              onClick={() => addExclusion(pattern)}
              data-testid="desktop-activity-exclude-add"
            >
              {t("desktop.activity.exclude.add")}
            </Button>
          </div>
        </div>

        <SettingRow
          title={t("desktop.activity.retention.title")}
          description={t("desktop.activity.retention.description")}
          htmlFor="desktop-activity-retention"
          testId="setting-desktop-activity-retention"
        >
          <NumberField
            id="desktop-activity-retention"
            value={settings.retentionDays}
            onCommit={(retentionDays) => void update({ retentionDays })}
            min={MIN_ACTIVITY_RETENTION_DAYS}
            max={MAX_ACTIVITY_RETENTION_DAYS}
            suffix={t("desktop.activity.retention.suffix")}
            aria-label={t("desktop.activity.retention.label")}
            testId="desktop-activity-retention"
          />
        </SettingRow>

        <SettingRow
          title={t("desktop.activity.wipe.title")}
          description={
            <>
              {t("desktop.activity.wipe.description", { count: snapshot.storedSegments })}
              {wiped ? (
                <span className="mt-2 block" role="status" data-testid="desktop-activity-wiped">
                  {t("desktop.activity.wipe.done")}
                </span>
              ) : null}
              {failed ? (
                <span className="mt-2 block text-destructive" role="alert" data-testid="desktop-activity-failed">
                  {t("desktop.activity.failed")}
                </span>
              ) : null}
            </>
          }
          testId="setting-desktop-activity-wipe"
        >
          <Button
            variant="destructive"
            onClick={() => setConfirmingWipe(true)}
            data-testid="desktop-activity-wipe"
            data-stored={snapshot.storedSegments}
          >
            {t("desktop.activity.wipe.button")}
          </Button>
        </SettingRow>
      </CardContent>

      <ConfirmDialog
        open={confirmingWipe}
        onOpenChange={setConfirmingWipe}
        title={t("desktop.activity.wipe.confirmTitle")}
        description={t("desktop.activity.wipe.confirmHint")}
        onConfirm={() => {
          const activity = desktopActivity();
          if (activity === null) return;
          activity.wipe().then(
            (next) => {
              setSnapshot(next);
              setWiped(true);
              setFailed(false);
            },
            () => setFailed(true),
          );
        }}
        testId="desktop-activity-wipe-confirm"
      />
    </Card>
  );
}
