"use client";

import * as React from "react";
import type { DesktopUpdateSnapshot } from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { desktopShell } from "@/lib/desktop-shell";

const LAST_CHECKED: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

/**
 * Settings → Desktop → Updates (Stage 7): the running version, what the
 * updater is doing, "Check for updates" and "Restart to update".
 *
 * The main process decides everything (`electron/src/updater-model.ts`): which
 * copies update themselves, when to check, and that a downloaded update waits
 * for the person. This card only shows the status and forwards two clicks.
 * "Restart to update" is the one place the app is ever restarted for an
 * update; nothing calls it on a timer.
 */
export function DesktopUpdatesCard(): React.JSX.Element | null {
  const t = useT("settings");
  const f = useFormat();
  const [snapshot, setSnapshot] = React.useState<DesktopUpdateSnapshot | null>(null);
  const [restarting, setRestarting] = React.useState(false);

  React.useEffect(() => {
    const updates = desktopShell()?.updates;
    if (!updates) return;
    let live = true;
    void updates
      .getStatus()
      .then((next) => {
        if (live) setSnapshot(next);
      })
      .catch(() => undefined);
    const off = updates.onStatus((next) => setSnapshot(next));
    return () => {
      live = false;
      off();
    };
  }, []);

  if (snapshot === null) return null;
  const { status } = snapshot;

  const check = (): void => {
    const updates = desktopShell()?.updates;
    if (!updates) return;
    void updates
      .check()
      .then(setSnapshot)
      .catch(() => undefined);
  };

  const restart = (): void => {
    const updates = desktopShell()?.updates;
    if (!updates) return;
    setRestarting(true);
    void updates
      .restart()
      .then((started) => {
        if (!started) setRestarting(false);
      })
      .catch(() => setRestarting(false));
  };

  let message: string;
  switch (status.kind) {
    case "disabled":
      message = t(`desktop.updates.disabled.${status.reason}`);
      break;
    case "idle":
      message =
        status.lastCheckedAt === null
          ? t("desktop.updates.status.idle")
          : t("desktop.updates.status.upToDate", { when: f.date(status.lastCheckedAt, LAST_CHECKED) });
      break;
    case "checking":
      message = t("desktop.updates.status.checking");
      break;
    case "downloading":
      message =
        status.percent === null
          ? t("desktop.updates.status.downloading", { version: status.version })
          : t("desktop.updates.status.downloadingPercent", {
              version: status.version,
              percent: f.percent(status.percent / 100),
            });
      break;
    case "ready":
      message = t("desktop.updates.status.ready", { version: status.version });
      break;
    case "error":
      message = t("desktop.updates.status.error");
      break;
  }

  const canCheck = status.kind === "idle" || status.kind === "error";

  return (
    <Card data-testid="settings-desktop-updates" data-status={status.kind}>
      <CardHeader>
        <CardTitle>{t("desktop.updates.title")}</CardTitle>
        <CardDescription data-testid="desktop-update-version">
          {t("desktop.updates.version", { version: snapshot.currentVersion })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="desktop-update-status">
          {message}
        </p>
        {status.kind === "ready" ? (
          <Button onClick={restart} disabled={restarting} data-testid="desktop-update-restart" className="shrink-0">
            {t("desktop.updates.restart")}
          </Button>
        ) : status.kind !== "disabled" ? (
          <Button
            variant="outline"
            onClick={check}
            disabled={!canCheck}
            data-testid="desktop-update-check"
            className="shrink-0"
          >
            {t("desktop.updates.check")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
