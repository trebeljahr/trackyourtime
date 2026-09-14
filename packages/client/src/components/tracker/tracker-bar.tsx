"use client";
import { PRODUCT_NAME } from "@/lib/site-links";

import * as React from "react";
import {
  AlertTriangle,
  Building2,
  CloudOff,
  Play,
  Plus,
  Square,
  UserRoundX,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import type { DescriptionSuggestion, EntryFields } from "@starter/core";
import { formatDuration } from "@starter/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ProjectTaskPicker } from "@/components/entry-fields/project-task-picker";
import { TagPicker } from "@/components/tags/tag-picker";
import { BillableGlyph } from "@/components/tracker/billable-glyph";
import { DescriptionCombobox } from "@/components/tracker/description-combobox";
import { ManualEntryDialog } from "@/components/tracker/manual-entry-dialog";
import { QuickStartMenu } from "@/components/tracker/quick-start-menu";
import { useEntryMutations } from "@/components/tracker/use-entry-mutations";
import { useIdleGuard } from "@/components/tracker/use-idle-guard";
import { useRunawayGuard } from "@/components/tracker/use-runaway-guard";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";
import { useActiveWorkspace } from "@/components/workspace-switcher";
import { useT } from "@/i18n/use-t";
import { useRunningEntry } from "@/hooks/use-sync";
import { useFormatSettings } from "@/lib/format";
import { isNative } from "@/mobile/bridge";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * The bar the whole product is used through: description, project, billable,
 * the live elapsed clock and one big Start/Stop button — plus a separate
 * button that opens the dialog for logging time that was never timed.
 */
export function TrackerBar(): React.JSX.Element {
  const { entry: running, elapsedSec, clockSkewed } = useRunningEntry();
  const format = useFormatSettings();
  const mutations = useEntryMutations();
  useRunawayGuard(mutations);
  // The shell owns the queue, so it keeps draining on Reports and Settings
  // too — see providers/offline-queue-provider.tsx.
  const { pending, foreign, online, authBlocked } = useOfflineQueueState();
  const projects = trpc.projects.list.useQuery({});
  const t = useT("tracker");
  const { activeId, workspaces } = useActiveWorkspace();

  const [manualOpen, setManualOpen] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [taskId, setTaskId] = React.useState<string | null>(null);
  const [billable, setBillable] = React.useState(false);
  const [tagIds, setTagIds] = React.useState<string[]>([]);

  const isRunning = running !== null;

  /*
   * The timer is per person, not per workspace, so the entry running now can
   * belong to a workspace other than the one on screen. It can still be
   * stopped from here (a stop names the person's timer wherever it runs), but
   * not edited: every edit is addressed to the workspace on screen, where
   * that entry does not exist, and this workspace's projects and tags would
   * be the wrong picker for it anyway.
   */
  const runningElsewhere =
    running !== null && activeId !== null && running.workspaceId !== activeId;
  const runningWorkspaceName = runningElsewhere
    ? (workspaces?.find((workspace) => workspace.id === running.workspaceId)
        ?.name ?? null)
    : null;
  const editsRunning = isRunning && !runningElsewhere;

  // Adopt the running entry's fields whenever the timer identity changes —
  // including a start or stop that happened on another device. Render-time
  // sync (rather than an effect) keeps the inputs correct on the very first
  // paint after a cross-device change.
  const runningId = running?.id ?? null;
  const [lastRunningId, setLastRunningId] = React.useState<string | null>(null);
  if (lastRunningId !== runningId) {
    setLastRunningId(runningId);
    setDescription(running?.description ?? "");
    setProjectId(running?.projectId ?? null);
    setTaskId(running?.taskId ?? null);
    setBillable(running?.billable ?? false);
    setTagIds(running?.tagIds ?? []);
  }

  // Mounted here rather than in the app shell so the detector lives exactly as
  // long as the screen that owns the timer.
  useIdleGuard();

  // Publish this bar's height so the day headings below it know where to come
  // to rest when they stick. The bar grows a second line for the offline
  // badges, so a constant would be wrong exactly when it matters.
  const barRef = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    const node = barRef.current;
    if (node === null) return;

    const root = document.documentElement;
    const observer = new ResizeObserver(([record]) => {
      const height = record?.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      root.style.setProperty("--tracker-bar-height", `${height}px`);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--tracker-bar-height");
    };
  }, []);

  // Live elapsed time in the tab title, so a backgrounded tab still shows it.
  React.useEffect(() => {
    if (running === null) {
      document.title = PRODUCT_NAME;
      return;
    }
    const label = running.description.trim();
    document.title = `${formatDuration(elapsedSec, "hms")}${label === "" ? "" : ` · ${label}`}`;
    return () => {
      document.title = PRODUCT_NAME;
    };
  }, [running, elapsedSec]);

  const projectBillableDefault = React.useCallback(
    (nextProjectId: string | null): boolean => {
      if (nextProjectId === null) return false;
      const project = projects.data?.find(
        (candidate) => candidate.id === nextProjectId
      );
      return project?.billableDefault ?? false;
    },
    [projects.data]
  );

  // What the shared control reads and writes. The bar keeps the five values
  // in separate state because the description and the billable flag have
  // behaviour of their own here (Escape restores, the project default decides
  // the flag), so this assembles the view rather than owning it.
  const fields: EntryFields = React.useMemo(
    () => ({ description, projectId, taskId, billable, tagIds }),
    [billable, description, projectId, tagIds, taskId]
  );

  const applyFields = React.useCallback(
    (next: EntryFields, patch: Partial<EntryFields>): void => {
      setProjectId(next.projectId);
      setTaskId(next.taskId);

      // A running timer is edited in place; the composer is only prepared.
      // One running in another workspace is not edited at all (see
      // `runningElsewhere`).
      if (isRunning) {
        if (editsRunning && running) {
          mutations.updateEntry({ id: running.id, ...patch });
        }
        return;
      }
      // Picking a project adopts its billable default — but only for a timer
      // that has not started, where nothing has been decided yet.
      if (patch.projectId !== undefined) {
        setBillable(projectBillableDefault(next.projectId));
      }
    },
    [editsRunning, isRunning, mutations, projectBillableDefault, running]
  );

  const handleTagsChange = React.useCallback(
    (next: string[]): void => {
      setTagIds(next);
      // Labelling a running entry has to stick immediately — the whole point
      // of tagging as you go is that you do it while the timer runs.
      if (editsRunning && running) {
        mutations.updateEntry({ id: running.id, tagIds: next });
      }
    },
    [editsRunning, mutations, running]
  );

  const handleBillableToggle = React.useCallback((): void => {
    const next = !billable;
    setBillable(next);
    if (editsRunning && running) {
      mutations.updateEntry({ id: running.id, billable: next });
    }
  }, [billable, editsRunning, mutations, running]);

  // Takes the text explicitly: it is called from inside the field's key and
  // blur handlers, where this render's `description` may not have caught up.
  const commitDescription = React.useCallback(
    (next: string): void => {
      if (!editsRunning || running === null) return;
      if (next === running.description) return;
      mutations.updateEntry({ id: running.id, description: next });
    },
    [editsRunning, mutations, running]
  );

  // A suggestion taken with everything it carries. On a running timer that is
  // one edit of five fields; on the composer it only prepares the next start,
  // and the suggestion's billable flag wins over the project default because
  // it is what that work was actually billed as last time.
  const fillFromSuggestion = React.useCallback(
    (suggestion: DescriptionSuggestion): void => {
      setDescription(suggestion.description);
      setProjectId(suggestion.projectId);
      setTaskId(suggestion.taskId);
      setBillable(suggestion.billable);
      setTagIds(suggestion.tagIds);
      if (editsRunning && running) {
        mutations.updateEntry({
          id: running.id,
          description: suggestion.description,
          projectId: suggestion.projectId,
          taskId: suggestion.taskId,
          billable: suggestion.billable,
          tagIds: suggestion.tagIds,
        });
      }
    },
    [editsRunning, mutations, running]
  );

  const start = React.useCallback((): void => {
    mutations.startTimer({ description, projectId, taskId, billable, tagIds });
  }, [billable, description, mutations, projectId, tagIds, taskId]);

  const stop = React.useCallback((): void => {
    mutations.stopTimer();
  }, [mutations]);

  const toggle = React.useCallback((): void => {
    if (isRunning) stop();
    else start();
  }, [isRunning, start, stop]);

  // Cmd/Ctrl+Enter toggles the timer from anywhere on the page, including
  // from inside another field.
  const toggleRef = React.useRef(toggle);
  React.useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Enter") return;
      if (!event.metaKey && !event.ctrlKey) return;
      // The description field's secondary action (Cmd/Ctrl+Enter on a
      // highlighted suggestion) already used this keystroke.
      if (event.defaultPrevented) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div
      ref={barRef}
      className="sticky top-14 z-30 -mx-3 mb-6 border-b border-border bg-background/95 px-3 py-3 backdrop-blur md:-mx-6 md:px-6"
      data-testid="tracker-bar"
      data-running={isRunning ? "true" : "false"}
    >
      {/* Its own line above the composer. Sharing the row meant it was the
          first thing before the description field and shifted every control
          after it by its own width; on a line of its own the composer row
          starts at the same place whether or not there is anything to quick
          start. Hidden while a timer runs, where it would only offer to stop
          this one and start another. */}
      {isRunning ? null : (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <QuickStartMenu mutations={mutations} />
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="tracker-composer"
      >
        <DescriptionCombobox
          value={description}
          committed={running?.description ?? ""}
          onValueChange={setDescription}
          onCommit={commitDescription}
          onSubmit={toggle}
          onFill={fillFromSuggestion}
          /* On a phone this opened the software keyboard on every mount of
             /track — half the screen gone, over the entries the user came to
             read, before they had done anything. Focus-on-mount is a
             keyboard-first affordance and a phone has no keyboard to be first
             with. Evaluated at render rather than baked in: under
             `output: "export"` the prerender runs in Node where `isNative()`
             is false, but React never serialises `autoFocus` into the markup
             — it focuses imperatively on mount — so the native value is the
             one that decides. */
          autoFocus={!isNative()}
          className="min-w-0 flex-1 basis-64"
          inputClassName="h-10 border-0 bg-transparent px-2 text-base shadow-none focus-visible:ring-0"
          testId="tracker-description"
        />

        {/* The client is a property of the project, not a field of its own —
            it rides along inside this control, shown read-only, which is what
            stops "Redesign" from being ambiguous when two clients both have
            one without adding a picker to a bar that is already wide. */}
        <ProjectTaskPicker
          value={fields}
          onChange={applyFields}
          bare
          controlClassName="h-10"
          testIdPrefix="tracker"
        />

        <TagPicker
          value={tagIds}
          onChange={handleTagsChange}
          maxChips={2}
          className="h-10 border-0 shadow-none"
          testId="tracker-tags"
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={billable ? "Billable" : "Not billable"}
          aria-pressed={billable}
          title={billable ? "Billable" : "Not billable"}
          className="cap-touch"
          onClick={handleBillableToggle}
          data-testid="tracker-billable"
          data-billable={billable ? "true" : "false"}
        >
          <BillableGlyph billable={billable} />
        </Button>

        <Separator orientation="vertical" className="hidden h-8 sm:block" />

        <span
          className="w-24 shrink-0 text-right font-mono text-lg tabular-nums"
          data-testid="tracker-elapsed"
          data-running={isRunning ? "true" : "false"}
        >
          {format.duration(isRunning ? elapsedSec : 0)}
        </span>

        {/* Start and + stay one unit: the bar wraps on narrow screens, and
            an orphaned + on its own line reads like it belongs to the row
            below it. */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            className={cn(
              "w-24 shrink-0",
              isRunning &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            )}
            onClick={toggle}
            data-testid="tracker-toggle"
            data-state={isRunning ? "running" : "idle"}
          >
            {isRunning ? (
              <>
                <Square /> Stop
              </>
            ) : (
              <>
                <Play /> Start
              </>
            )}
          </Button>

          {/* A button, not a mode: logging past work is one action that ends
              when the dialog closes, so the bar can never be left sitting in a
              state where Start has quietly turned into Add.

              Gone entirely while a timer runs. Sitting next to Stop it read
              like it would add something TO the running entry, and logging a
              past block is never what you reach for mid-timer anyway. */}
          {isRunning ? null : (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="cap-touch shrink-0"
              aria-label="Add time entry"
              title="Add time entry"
              onClick={() => setManualOpen(true)}
              data-testid="tracker-manual-open"
            >
              <Plus />
            </Button>
          )}
        </div>
      </div>

      {pending > 0 || foreign > 0 || !online || clockSkewed || runningElsewhere ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {runningElsewhere ? (
            <Badge
              variant="outline"
              className="gap-1.5"
              title={t("workspace.runningElsewhereHint", {
                name: runningWorkspaceName ?? "",
              })}
              data-testid="tracker-running-elsewhere"
              data-workspace-id={running?.workspaceId ?? ""}
            >
              <Building2 className="size-3" />
              {t("workspace.runningElsewhere", {
                name: runningWorkspaceName ?? "…",
              })}
            </Badge>
          ) : null}

          {/*
            Nothing was thrown away — the queue stopped rather than replaying
            into a session the server no longer knows. Say so, because the
            alternative reading of a stuck pending count is "my time is lost".
          */}
          {authBlocked ? (
            <Badge
              variant="outline"
              className="gap-1.5 border-destructive/50 text-destructive"
              data-testid="offline-auth-blocked"
            >
              <CloudOff className="size-3" /> Signed out — sign in to sync
            </Badge>
          ) : null}

          {/*
            A clock stuck at 0:00 while the timer genuinely runs is the most
            unexplainable-looking bug this app can show. It is not ours: the
            device thinks "now" is before the entry started, so every elapsed
            calculation clamps to zero. Naming it turns a support ticket into
            a settings change.
          */}
          {clockSkewed ? (
            <Badge
              variant="outline"
              className="gap-1.5 border-destructive/50 text-destructive"
              data-testid="clock-skew-warning"
            >
              <AlertTriangle className="size-3" /> Device clock looks wrong
            </Badge>
          ) : null}

          {!online ? (
            <Badge variant="outline" className="gap-1.5" data-testid="offline-indicator">
              <WifiOff className="size-3" /> Offline
            </Badge>
          ) : null}

          {pending > 0 ? (
            <Badge
              variant="outline"
              className="gap-1.5"
              data-testid="offline-pending"
              data-pending={pending}
            >
              <CloudOff className="size-3" />
              {pending} change{pending === 1 ? "" : "s"} pending
            </Badge>
          ) : null}

          {/*
            Somebody else's unsynced time is sitting on this device. It is
            deliberately not replayed — it would land in the wrong workspace —
            and just as deliberately not deleted. Neither of those is something
            to do silently, so the count is on screen with the reason.
          */}
          {foreign > 0 ? (
            <Link href="/settings?tab=devices" title={t("queue.heldHint")}>
              <Badge
                variant="outline"
                className="gap-1.5 hover:bg-accent"
                data-testid="offline-foreign"
                data-foreign={foreign}
              >
                <UserRoundX className="size-3" />
                {t("queue.held", { count: foreign })}
              </Badge>
            </Link>
          ) : null}
        </div>
      ) : null}

      <ManualEntryDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        // Seeded from the composer, so typing a description and then reaching
        // for the + does not throw that away. While a timer runs the composer
        // mirrors the running entry, which is not a draft for a new block.
        seed={
          isRunning
            ? {
                description: "",
                projectId: null,
                taskId: null,
                billable: false,
                tagIds: [],
              }
            : { description, projectId, taskId, billable, tagIds }
        }
        mutations={mutations}
      />
    </div>
  );
}
