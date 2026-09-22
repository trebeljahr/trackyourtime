"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import {
  DEFAULT_DESKTOP_SHORTCUTS,
  DESKTOP_SHORTCUT_ACTIONS,
  type DesktopSettingsPatch,
  type DesktopSettingsSnapshot,
  type DesktopShortcutAction,
  type DesktopShortcutStatus,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { DesktopActivityCard } from "@/components/settings/desktop-activity";
import { DesktopUpdatesCard } from "@/components/settings/desktop-updates";
import { SettingRow } from "@/components/settings/setting-row";
import { useT } from "@/i18n/use-t";
import {
  desktopShell,
  formatAccelerator,
  recordKey,
  stealsTypedCharacter,
  type KeyWords,
} from "@/lib/desktop-shell";

type Problem = Pick<DesktopShortcutStatus, "problem" | "accelerator" | "conflictsWith">;

/**
 * Settings → Desktop: open at login, the tray, the close button, the running
 * badge and the global shortcuts. Rendered by the settings page only in the
 * desktop app, after hydration.
 *
 * The main process owns these values (they are per computer and needed before
 * any page loads), so this panel reads a snapshot over the bridge, writes a
 * patch back and follows `onSettingsChanged`. What it shows about a shortcut
 * is what the main process reports: a binding refused before saving, or one
 * `globalShortcut.register` could not take because another app holds it.
 */
export function DesktopSettingsPanel(): React.JSX.Element | null {
  const t = useT("settings");
  const [snapshot, setSnapshot] = React.useState<DesktopSettingsSnapshot | null>(null);
  const [refused, setRefused] = React.useState<Partial<Record<DesktopShortcutAction, Problem>>>({});
  const [recording, setRecording] = React.useState<DesktopShortcutAction | null>(null);
  const [attempt, setAttempt] = React.useState<string | null>(null);
  const platform = typeof window === "undefined" ? "" : (window.electronAPI?.platform ?? "");

  React.useEffect(() => {
    const shell = desktopShell();
    if (shell === null) return;
    let live = true;
    void shell.getSettings().then((next) => {
      if (live) setSnapshot(next);
    });
    const off = shell.onSettingsChanged((next) => setSnapshot(next));
    return () => {
      live = false;
      off();
    };
  }, []);

  const update = React.useCallback(async (patch: DesktopSettingsPatch): Promise<void> => {
    const shell = desktopShell();
    if (shell === null) return;
    const result = await shell.updateSettings(patch);
    setSnapshot(result.snapshot);
    setRefused((current) => {
      const next = { ...current };
      for (const action of Object.keys(patch.shortcuts ?? {}) as DesktopShortcutAction[]) delete next[action];
      for (const status of result.refused) next[status.action] = status;
      return next;
    });
  }, []);

  const stopRecording = React.useCallback((): void => {
    setRecording(null);
    setAttempt(null);
    void desktopShell()?.suspendShortcuts(false).catch(() => undefined);
  }, []);

  const startRecording = React.useCallback((action: DesktopShortcutAction): void => {
    setRecording(action);
    setAttempt(null);
    // A registered global shortcut is swallowed by the OS before this page
    // sees the key, so pressing the current binding again could not record it.
    void desktopShell()?.suspendShortcuts(true).catch(() => undefined);
  }, []);

  // Listening on the window, capturing, while a recorder is open: every key
  // belongs to the recorder, including Cmd+K and Cmd/Ctrl+Enter, which the
  // shell and the tracker would otherwise act on.
  React.useEffect(() => {
    if (recording === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const result = recordKey(event, platform);
      if (result.kind === "pending") return;
      if (result.kind === "cancel") {
        stopRecording();
        return;
      }
      if (result.kind === "invalid") {
        setAttempt(result.attempted);
        return;
      }
      const action = recording;
      stopRecording();
      void update({ shortcuts: { [action]: result.accelerator } });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [platform, recording, stopRecording, update]);

  // Leaving the page mid-recording must give the shortcuts back.
  React.useEffect(() => () => void desktopShell()?.suspendShortcuts(false).catch(() => undefined), []);

  const words: KeyWords = {
    ctrl: t("desktop.shortcuts.keys.ctrl"),
    alt: t("desktop.shortcuts.keys.alt"),
    shift: t("desktop.shortcuts.keys.shift"),
    win: t("desktop.shortcuts.keys.win"),
    super: t("desktop.shortcuts.keys.super"),
    space: t("desktop.shortcuts.keys.space"),
    enter: t("desktop.shortcuts.keys.enter"),
    escape: t("desktop.shortcuts.keys.escape"),
    backspace: t("desktop.shortcuts.keys.backspace"),
    delete: t("desktop.shortcuts.keys.delete"),
  };
  const show = (accelerator: string): string => formatAccelerator(accelerator, platform, words);

  if (snapshot === null) return null;
  const { settings, capabilities } = snapshot;
  const mac = platform === "darwin";

  const problemText = (problem: Problem): string | null => {
    const shortcut = problem.accelerator ? show(problem.accelerator) : "";
    switch (problem.problem) {
      case "taken":
        return t("desktop.shortcuts.problems.taken", { shortcut });
      case "invalid":
        return t("desktop.shortcuts.problems.invalid", { shortcut });
      case "duplicate":
        return t("desktop.shortcuts.problems.duplicate", {
          shortcut,
          action: problem.conflictsWith ? t(`desktop.shortcuts.actions.${problem.conflictsWith}.title`) : "",
        });
      default:
        return null;
    }
  };

  const modifiersHint = mac
    ? t("desktop.shortcuts.modifiersMac")
    : t("desktop.shortcuts.modifiersOther", {
        ctrl: words.ctrl,
        alt: words.alt,
        super: platform === "win32" ? words.win : words.super,
      });

  return (
    <>
      <Card data-testid="settings-desktop">
        <CardHeader>
          <CardTitle>{t("desktop.app.title")}</CardTitle>
          <CardDescription>{t("desktop.app.description")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border py-0">
          <SettingRow
            title={t("desktop.openAtLogin.title")}
            description={
              snapshot.loginItem === "requires-approval"
                ? t("desktop.openAtLogin.requiresApproval")
                : snapshot.loginItem === "unsupported"
                  ? t("desktop.openAtLogin.unsupported")
                  : t("desktop.openAtLogin.description")
            }
            testId="setting-desktop-open-at-login"
          >
            <Switch
              checked={settings.openAtLogin}
              disabled={snapshot.loginItem === "unsupported"}
              onCheckedChange={(openAtLogin) => void update({ openAtLogin })}
              aria-label={t("desktop.openAtLogin.title")}
              data-testid="desktop-open-at-login"
              data-status={snapshot.loginItem}
            />
          </SettingRow>

          <SettingRow
            title={mac ? t("desktop.tray.titleMac") : t("desktop.tray.titleOther")}
            description={t("desktop.tray.description")}
            testId="setting-desktop-tray"
          >
            <Switch
              checked={settings.showInTray}
              onCheckedChange={(showInTray) => void update({ showInTray })}
              aria-label={mac ? t("desktop.tray.titleMac") : t("desktop.tray.titleOther")}
              data-testid="desktop-show-in-tray"
            />
          </SettingRow>

          {capabilities.closeHides ? (
            <SettingRow
              title={t("desktop.closeHides.title")}
              description={
                settings.showInTray ? t("desktop.closeHides.description") : t("desktop.closeHides.needsTray")
              }
              testId="setting-desktop-close-hides"
            >
              <Switch
                checked={settings.closeHides && settings.showInTray}
                disabled={!settings.showInTray}
                onCheckedChange={(closeHides) => void update({ closeHides })}
                aria-label={t("desktop.closeHides.title")}
                data-testid="desktop-close-hides"
              />
            </SettingRow>
          ) : null}

          {capabilities.runningBadge ? (
            <SettingRow
              title={mac ? t("desktop.runningBadge.titleMac") : t("desktop.runningBadge.titleWindows")}
              description={t("desktop.runningBadge.description")}
              testId="setting-desktop-running-badge"
            >
              <Switch
                checked={settings.runningBadge}
                onCheckedChange={(runningBadge) => void update({ runningBadge })}
                aria-label={mac ? t("desktop.runningBadge.titleMac") : t("desktop.runningBadge.titleWindows")}
                data-testid="desktop-running-badge"
              />
            </SettingRow>
          ) : null}
        </CardContent>
      </Card>

      <Card data-testid="settings-desktop-shortcuts">
        <CardHeader>
          <CardTitle>{t("desktop.shortcuts.title")}</CardTitle>
          <CardDescription>{t("desktop.shortcuts.description")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border py-0">
          {DESKTOP_SHORTCUT_ACTIONS.map((action) => {
            const bound = settings.shortcuts[action];
            const status = snapshot.shortcuts.find((candidate) => candidate.action === action);
            const problem = refused[action] ?? (status?.problem ? status : null);
            const message = problem ? problemText(problem) : null;
            const isRecording = recording === action;
            const fallback = DEFAULT_DESKTOP_SHORTCUTS[action];
            return (
              <SettingRow
                key={action}
                title={t(`desktop.shortcuts.actions.${action}.title`)}
                description={
                  <>
                    {t(`desktop.shortcuts.actions.${action}.description`)}
                    {message ? (
                      <span
                        className="mt-2 flex items-start gap-1.5 text-destructive"
                        role="alert"
                        data-testid={`desktop-shortcut-problem-${action}`}
                        data-problem={problem?.problem ?? ""}
                      >
                        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                        {message}
                      </span>
                    ) : null}
                    {bound && stealsTypedCharacter(bound, platform) ? (
                      <span className="mt-2 block text-muted-foreground">{t("desktop.shortcuts.optionWarning")}</span>
                    ) : null}
                  </>
                }
                testId={`setting-desktop-shortcut-${action}`}
              >
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {isRecording ? (
                    <span
                      className="rounded-md border border-primary px-2 py-1 text-sm"
                      aria-live="polite"
                      data-testid={`desktop-shortcut-recording-${action}`}
                    >
                      {attempt
                        ? t("desktop.shortcuts.problems.invalid", { shortcut: attempt })
                        : t("desktop.shortcuts.recording")}
                      <span className="block text-xs text-muted-foreground">
                        {t("desktop.shortcuts.recordingHint", { modifiers: modifiersHint })}
                      </span>
                    </span>
                  ) : (
                    <kbd
                      className={
                        bound
                          ? "rounded-md border border-border bg-muted px-2 py-1 font-mono text-sm"
                          : "px-2 py-1 text-sm text-muted-foreground"
                      }
                      data-testid={`desktop-shortcut-value-${action}`}
                      data-accelerator={bound ?? ""}
                      data-registered={status?.registered ? "true" : "false"}
                    >
                      {bound ? show(bound) : t("desktop.shortcuts.notSet")}
                    </kbd>
                  )}
                  {isRecording ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={stopRecording}
                      data-testid={`desktop-shortcut-cancel-${action}`}
                    >
                      {t("desktop.shortcuts.cancel")}
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startRecording(action)}
                        data-testid={`desktop-shortcut-record-${action}`}
                      >
                        {bound ? t("desktop.shortcuts.change") : t("desktop.shortcuts.set")}
                      </Button>
                      {bound ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void update({ shortcuts: { [action]: null } })}
                          data-testid={`desktop-shortcut-clear-${action}`}
                        >
                          {t("desktop.shortcuts.clear")}
                        </Button>
                      ) : null}
                      {fallback && bound !== fallback ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void update({ shortcuts: { [action]: fallback } })}
                          data-testid={`desktop-shortcut-reset-${action}`}
                        >
                          {t("desktop.shortcuts.reset", { shortcut: show(fallback) })}
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </SettingRow>
            );
          })}
        </CardContent>
      </Card>

      <DesktopActivityCard />

      <DesktopUpdatesCard />
    </>
  );
}
