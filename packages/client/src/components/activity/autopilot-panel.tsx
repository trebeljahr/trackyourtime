"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { DesktopActivitySnapshot, DesktopAutopilotLogEntry } from "@starter/shared";

import { filingLabel } from "@/components/activity/autopilot-driver";
import { useActivePause } from "@/components/activity/use-desktop-activity";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

/**
 * The top of /app/activity in the desktop app: whether Autopilot is on (and
 * paused), what it is looking at, and everything it did in the last day —
 * each start with its Undo while that timer is still its own.
 */
export function AutopilotPanel({
  snapshot,
  projectName,
  clock,
  span,
  onToggle,
  onPause,
  onUndo,
  busy,
}: {
  snapshot: DesktopActivitySnapshot;
  projectName: (id: string | null | undefined) => string | null;
  clock: (ms: number) => string;
  span: (ms: number) => string;
  onToggle: (on: boolean) => void;
  /** Pause for an hour (true), or resume now (false). */
  onPause: (paused: boolean) => void;
  onUndo: (entry: DesktopAutopilotLogEntry) => void;
  busy: boolean;
}): React.JSX.Element | null {
  const t = useT("activity");
  const pausedUntil = useActivePause(snapshot.autopilot?.pausedUntil);
  if (!snapshot.support.supported || snapshot.autopilot === undefined) return null;
  const { settings } = snapshot;
  const state = snapshot.autopilot;
  const on = settings.autopilot;

  if (!on || !settings.enabled) {
    return (
      <section
        className="flex flex-col gap-4 rounded-xl border border-brand/20 bg-gradient-to-br from-brand/10 via-background to-background p-5 sm:flex-row sm:items-center"
        data-testid="autopilot-panel"
        data-state="off"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand" aria-hidden>
          <Sparkles className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="font-semibold">{t("autopilot.panel.offTitle")}</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            {settings.enabled ? t("autopilot.panel.offBody") : t("autopilot.panel.needsCapture")}
          </p>
        </div>
        {settings.enabled ? (
          <Button type="button" onClick={() => onToggle(true)} data-testid="autopilot-turn-on">
            {t("autopilot.panel.turnOn")}
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/app/settings?tab=desktop" data-testid="autopilot-open-settings">
              {t("autopilot.panel.openSettings")}
            </Link>
          </Button>
        )}
      </section>
    );
  }

  const watch = state.watch;
  const owned = state.owned;
  const threshold = span(settings.autopilotStartMinutes * 60_000);
  const status = ((): string | null => {
    if (owned !== null) {
      const started = state.log.find((entry) => entry.id === owned.logId);
      return t("autopilot.panel.tracking", { label: filingLabel(started?.filing?.fields ?? {}, projectName, t) });
    }
    // The paused line below says why nothing happens.
    if (pausedUntil !== null) return null;
    if (watch === null) return t("autopilot.panel.quiet");
    if (watch.held) return t("autopilot.panel.held");
    if (watch.filing === null) return t("autopilot.panel.unknown", { app: watch.app.name });
    return t("autopilot.panel.willStart", { label: filingLabel(watch.filing.fields, projectName, t), threshold });
  })();

  return (
    <section
      className="space-y-4 rounded-xl border border-brand/20 bg-gradient-to-br from-brand/10 via-background to-background p-5"
      data-testid="autopilot-panel"
      data-state="on"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand",
            watch !== null && owned === null && !watch.held && "motion-safe:animate-pulse",
          )}
          aria-hidden
        >
          <Sparkles className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="font-semibold">{t("autopilot.panel.title")}</h2>
          {watch !== null && owned === null ? (
            <p className="text-sm tabular-nums text-muted-foreground" data-testid="autopilot-watch">
              {t("autopilot.panel.watching", { app: watch.app.name, span: span(watch.creditedMs) })}
            </p>
          ) : null}
          {status !== null ? (
            <p className="text-sm" data-testid="autopilot-status">
              {status}
            </p>
          ) : null}
          {pausedUntil !== null ? (
            <p className="text-sm" data-testid="autopilot-paused">
              {t("autopilot.panel.paused", { time: clock(pausedUntil) })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("autopilot.panel.learned", { count: state.learnedApps })}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => onPause(pausedUntil === null)}
          data-testid={pausedUntil === null ? "autopilot-pause" : "autopilot-resume"}
        >
          {pausedUntil === null ? t("autopilot.panel.pause") : t("autopilot.panel.resume")}
        </Button>
        <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          {on ? t("autopilot.panel.on") : t("autopilot.panel.off")}
          <Switch
            checked={on}
            onCheckedChange={onToggle}
            aria-label={t("autopilot.panel.title")}
            data-testid="autopilot-switch"
          />
        </label>
      </div>

      <div className="space-y-2 border-t border-brand/15 pt-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("autopilot.panel.logHeading")}
        </h3>
        {state.log.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="autopilot-log-empty">
            {t("autopilot.panel.logEmpty")}
          </p>
        ) : (
          <ol className="space-y-1.5" data-testid="autopilot-log">
            {state.log.map((entry) => {
              const label = filingLabel(entry.filing?.fields ?? {}, projectName, t);
              const title =
                entry.kind === "stop"
                  ? t("autopilot.panel.log.stop")
                  : t(`autopilot.panel.log.${entry.kind}`, { label });
              const undoable = entry.kind === "start" && !entry.undone && owned?.logId === entry.id;
              return (
                <li
                  key={entry.id}
                  className={cn("flex items-center gap-3 text-sm", entry.undone && "text-muted-foreground line-through")}
                  data-testid="autopilot-log-entry"
                  data-kind={entry.kind}
                  data-undone={entry.undone ? "true" : "false"}
                >
                  <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{clock(entry.at)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {title}
                    {entry.app !== null ? <span className="text-muted-foreground"> · {entry.app.name}</span> : null}
                  </span>
                  {entry.undone ? (
                    <span className="shrink-0 text-xs no-underline">{t("autopilot.panel.undone")}</span>
                  ) : null}
                  {undoable ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2"
                      disabled={busy}
                      onClick={() => onUndo(entry)}
                      data-testid="autopilot-log-undo"
                    >
                      {t("autopilot.toast.undo")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
