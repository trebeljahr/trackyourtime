"use client";

import * as React from "react";
import { Maximize2, Pin, PinOff, Play, Square } from "lucide-react";
import type { DesktopCommand, DesktopTimerState } from "@starter/shared";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { useActiveWorkspace } from "@/components/workspace-switcher";
import { useRunningEntry } from "@/hooks/use-sync";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import type { DesktopWindowView } from "./use-desktop-window";

export function CompactTimer({
  state,
  onCommand,
  view,
  busy,
}: {
  state: DesktopTimerState;
  onCommand: (command: DesktopCommand) => void;
  view: DesktopWindowView;
  busy: boolean;
}): React.JSX.Element {
  const t = useT("shell");
  const { duration } = useFormatSettings();
  const { entry, elapsedSec } = useRunningEntry();
  const { activeId, workspaces } = useActiveWorkspace();
  const workspace = workspaces?.find(
    (item) => item.id === (entry?.workspaceId ?? activeId),
  );
  const main = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    main.current?.focus();
  }, []);
  const running = state.running;
  return (
    <section
      className="flex min-h-screen flex-col bg-background"
      data-testid="compact-timer"
    >
      <header
        className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3"
        data-window-drag
        data-compact-header
      >
        <BrandMark className="size-5" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          Track Your Time
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("desktop.compact.pin")}
          aria-pressed={view.alwaysOnTop}
          onClick={() => void view.setAlwaysOnTop(!view.alwaysOnTop)}
          data-testid="compact-pin"
        >
          {view.alwaysOnTop ? (
            <PinOff className="size-4" />
          ) : (
            <Pin className="size-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("desktop.compact.expand")}
          onClick={() => void view.setMode("full")}
          data-testid="compact-expand"
        >
          <Maximize2 className="size-4" />
        </Button>
      </header>
      <main
        ref={main}
        tabIndex={-1}
        aria-label={t("desktop.compact.title")}
        className="flex flex-1 flex-col gap-5 p-5 outline-none"
      >
        {workspace ? (
          <p
            className="truncate text-xs text-muted-foreground"
            data-testid="compact-workspace"
          >
            {workspace.name}
          </p>
        ) : null}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {running ? t("desktop.compact.running") : state.labels.noTimer}
          </p>
          <h1
            className="line-clamp-3 break-words text-2xl font-medium leading-tight tracking-tight"
            title={running?.description || undefined}
            data-testid="compact-description"
          >
            {running
              ? running.description.trim() ||
                running.projectName ||
                state.labels.noDescription
              : t("desktop.compact.ready")}
          </h1>
          {running?.projectName ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="compact-project"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                aria-hidden
                style={{
                  backgroundColor: running.projectColor ?? "currentColor",
                }}
              />
              <span className="truncate">{running.projectName}</span>
            </p>
          ) : null}
        </div>
        <p
          className="font-mono text-5xl tabular-nums tracking-tight"
          data-testid="compact-duration"
        >
          {duration(running ? elapsedSec : 0)}
        </p>
        <Button
          className="w-full"
          size="lg"
          disabled={busy}
          onClick={() => onCommand({ kind: running ? "stop" : "compose" })}
          data-testid="compact-primary"
        >
          {running ? (
            <Square className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
          {running ? state.labels.stop : state.labels.startTimer}
        </Button>
        <div className="min-h-0 flex-1">
          {state.recents.length > 0 ? (
            <>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                {state.labels.recentHeading}
              </h2>
              <div className="divide-y divide-border">
                {state.recents.map((recent) => (
                  <button
                    key={recent.key}
                    type="button"
                    disabled={busy}
                    className="flex w-full items-center gap-3 py-3 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                    onClick={() =>
                      onCommand({ kind: "continue", key: recent.key })
                    }
                    data-testid="compact-recent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {recent.label || state.labels.noDescription}
                      </span>
                      {recent.hint ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {recent.hint}
                        </span>
                      ) : null}
                    </span>
                    <Play
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("desktop.compact.noRecents")}
            </p>
          )}
        </div>
        {state.unsent > 0 ? (
          <p
            className="text-xs text-muted-foreground"
            role="status"
            data-testid="compact-unsent"
          >
            {state.labels.unsent}
          </p>
        ) : null}
        {view.failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("desktop.compact.failed")}
          </p>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void view.setMode("full")}
          data-testid="compact-open-app"
        >
          {t("desktop.compact.expand")}
        </Button>
      </main>
    </section>
  );
}
