"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  addDays,
  addMonths,
  addYears,
  endOfMonth,
  endOfWeek,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toDateKey } from "@/components/date-range-picker";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import {
  DEFAULT_VISIBLE_RANGE,
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
  clampZoomIndex,
  zoomPxPerMinute,
  type VisibleRange,
} from "./calendar-math";
import { formatDayRangeLabel } from "./day-range-label";
import { EntryCreateDialog, type CreateDraft } from "./entry-create-dialog";
import { MonthView } from "./month-view";
import { TimeGrid } from "./time-grid";
import { useCoarsePointer } from "./use-coarse-pointer";
import { YearView } from "./year-view";
import {
  useCalendarActions,
  useCalendarEntries,
  type CalendarQueryInput,
} from "./use-calendar-entries";

const CALENDAR_VIEWS = ["day", "week", "month", "year"] as const;
type CalendarView = (typeof CALENDAR_VIEWS)[number];

const isCalendarView = (value: string | null): value is CalendarView =>
  value !== null && CALENDAR_VIEWS.some((view) => view === value);

/** Selectable day windows for the day and week grids. */
const VISIBLE_RANGE_OPTIONS: {
  id: string;
  label: string;
  range: VisibleRange;
}[] = [
  { id: "work", label: "6:00 – 22:00", range: DEFAULT_VISIBLE_RANGE },
  { id: "core", label: "8:00 – 20:00", range: { startMin: 480, endMin: 1200 } },
  { id: "early", label: "5:00 – 14:00", range: { startMin: 300, endMin: 840 } },
  { id: "full", label: "0:00 – 24:00", range: { startMin: 0, endMin: 1440 } },
];

const RANGE_STORAGE_KEY = "trackyourtime.calendar.range";
const ZOOM_STORAGE_KEY = "trackyourtime.calendar.zoom";

const readStoredRangeId = (): string => {
  if (typeof window === "undefined") return "work";
  const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
  const match = VISIBLE_RANGE_OPTIONS.find((option) => option.id === stored);
  return match ? match.id : "work";
};

const readStoredZoomIndex = (): number => {
  if (typeof window === "undefined") return DEFAULT_ZOOM_INDEX;
  const raw = window.localStorage.getItem(ZOOM_STORAGE_KEY);
  if (raw === null) return DEFAULT_ZOOM_INDEX;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampZoomIndex(stored) : DEFAULT_ZOOM_INDEX;
};

/** `?date=` is the source of truth so every view is linkable. */
const parseDateParam = (raw: string | null): Date => {
  if (raw === null) return startOfDay(new Date());
  const parsed = parseISO(raw.length > 10 ? raw.slice(0, 10) : raw);
  return Number.isNaN(parsed.getTime()) ? startOfDay(new Date()) : parsed;
};

/** Entries are fetched for whole days so blocks are never half-loaded. */
const ENTRY_LIMIT = 500;

/** Views that render the draggable time grid. */
const GRID_VIEWS = new Set<CalendarView>(["day", "week"]);

/** The single-key shortcuts, mirroring what every calendar app binds. */
const VIEW_SHORTCUTS: Record<string, CalendarView> = {
  d: "day",
  w: "week",
  m: "month",
  y: "year",
};

/** True while the user is typing, when a bare letter must not navigate. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

export function CalendarScreen(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { weekStartsOn } = useFormatSettings();
  const f = useFormat();
  const t = useT("calendar");
  const tc = useT("common");

  // Only the *default*. `?view=` is still the source of truth, so a chosen
  // week view survives on a phone — this decides nothing but the first load.
  // Seven columns after a 3.5rem gutter leave ~44px per day at 390pt, which
  // is a week grid nobody can read, let alone tap.
  const coarsePointer = useCoarsePointer();

  const viewParam = searchParams.get("view");
  const view: CalendarView = isCalendarView(viewParam)
    ? viewParam
    : coarsePointer
      ? "day"
      : "week";
  const anchor = parseDateParam(searchParams.get("date"));
  const anchorMs = startOfDay(anchor).getTime();

  const [rangeId, setRangeId] = React.useState<string>(readStoredRangeId);
  const [zoomIndex, setZoomIndex] = React.useState<number>(readStoredZoomIndex);
  const [draft, setDraft] = React.useState<CreateDraft | null>(null);

  const pxPerMinute = zoomPxPerMinute(zoomIndex);

  const zoomBy = React.useCallback((delta: number): void => {
    setZoomIndex((current) => clampZoomIndex(current + delta));
  }, []);

  const resetZoom = React.useCallback((): void => {
    setZoomIndex(DEFAULT_ZOOM_INDEX);
  }, []);

  // Persisted outside the updater, which has to stay pure.
  React.useEffect(() => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(zoomIndex));
  }, [zoomIndex]);

  const preferredRange =
    VISIBLE_RANGE_OPTIONS.find((option) => option.id === rangeId)?.range ??
    DEFAULT_VISIBLE_RANGE;

  const navigate = React.useCallback(
    (next: { view?: CalendarView; date?: Date }): void => {
      const params = new URLSearchParams();
      params.set("view", next.view ?? view);
      params.set("date", toDateKey(next.date ?? new Date(anchorMs)));
      router.replace(`/app/calendar?${params.toString()}`, { scroll: false });
    },
    [anchorMs, router, view]
  );

  const weekStart = React.useMemo(
    () => startOfWeek(new Date(anchorMs), { weekStartsOn }),
    [anchorMs, weekStartsOn]
  );

  const gridDays = React.useMemo<Date[]>(() => {
    if (view === "day") return [new Date(anchorMs)];
    return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  }, [anchorMs, view, weekStart]);

  // The fetch window covers whole weeks so month cells are complete too. The
  // year view never lands here: it reads aggregated report data instead.
  const fetchWindow = React.useMemo(() => {
    if (view === "day") {
      const day = new Date(anchorMs);
      return { from: day, to: addDays(day, 1) };
    }
    if (view === "week") {
      return { from: weekStart, to: addDays(weekStart, 7) };
    }
    const month = new Date(anchorMs);
    return {
      from: startOfWeek(startOfMonth(month), { weekStartsOn }),
      to: addDays(endOfWeek(endOfMonth(month), { weekStartsOn }), 1),
    };
  }, [anchorMs, view, weekStart, weekStartsOn]);

  const listInput = React.useMemo<CalendarQueryInput>(
    () => ({
      from: fetchWindow.from.toISOString(),
      to: fetchWindow.to.toISOString(),
      limit: ENTRY_LIMIT,
    }),
    [fetchWindow]
  );

  const { entries, isLoading } = useCalendarEntries(listInput, view !== "year");
  const actions = useCalendarActions(listInput);
  const { history } = actions;

  const title = React.useMemo<string>(() => {
    const date = new Date(anchorMs);
    switch (view) {
      case "day":
        return f.date(date, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      case "week":
        return formatDayRangeLabel(weekStart, addDays(weekStart, 6), f.intlLocale);
      case "month":
        return f.date(date, "monthYear");
      case "year":
        return f.date(date, { year: "numeric" });
    }
  }, [anchorMs, f, view, weekStart]);

  const isGridView = GRID_VIEWS.has(view);

  const step = React.useCallback(
    (direction: -1 | 1): void => {
      const date = new Date(anchorMs);
      const next =
        view === "day"
          ? addDays(date, direction)
          : view === "week"
            ? addDays(date, direction * 7)
            : view === "month"
              ? addMonths(date, direction)
              : addYears(date, direction);
      navigate({ date: next });
    },
    [anchorMs, navigate, view]
  );

  // Keyboard navigation, the same bindings Google Calendar and Clockify use.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Undo/redo first: they are the only modifier bindings here, and inside
      // an input the browser's own text undo has to win instead.
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        if (isTypingTarget(event.target)) return;
        const key = event.key.toLowerCase();
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) history.redo();
          else history.undo();
          return;
        }
        if (key === "y" && !event.shiftKey) {
          event.preventDefault();
          history.redo();
          return;
        }
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const shortcut = VIEW_SHORTCUTS[event.key.toLowerCase()];
      if (shortcut) {
        event.preventDefault();
        navigate({ view: shortcut });
        return;
      }
      if (event.key === "t") {
        event.preventDefault();
        navigate({ date: new Date() });
        return;
      }
      if (isGridView && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        zoomBy(1);
        return;
      }
      if (isGridView && (event.key === "-" || event.key === "_")) {
        event.preventDefault();
        zoomBy(-1);
        return;
      }
      if (isGridView && event.key === "0") {
        event.preventDefault();
        resetZoom();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [history, isGridView, navigate, resetZoom, step, zoomBy]);

  const undoChange =
    history.undoLabel === null
      ? null
      : t(`history.changes.${history.undoLabel}`);
  const redoChange =
    history.redoLabel === null
      ? null
      : t(`history.changes.${history.redoLabel}`);

  const openBlankDraft = (): void => {
    const base = new Date(anchorMs);
    const start = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      9,
      0,
      0,
      0
    );
    const end = new Date(start.getTime() + 60 * 60_000);
    setDraft({ start: start.toISOString(), end: end.toISOString() });
  };

  return (
    <div className="space-y-4" data-testid="calendar-screen">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label={tc("actions.previous")}
            data-testid="calendar-prev"
            onClick={() => {
              step(-1);
            }}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="calendar-today"
            onClick={() => {
              navigate({ date: new Date() });
            }}
          >
            {tc("time.today")}
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={tc("actions.next")}
            data-testid="calendar-next"
            onClick={() => {
              step(1);
            }}
          >
            <ChevronRight className="size-4" />
          </Button>
          <h1
            className="ml-2 text-lg font-semibold"
            data-testid="calendar-title"
          >
            {title}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isGridView ? (
            <Select
              value={rangeId}
              onValueChange={(next) => {
                setRangeId(next);
                window.localStorage.setItem(RANGE_STORAGE_KEY, next);
              }}
            >
              <SelectTrigger
                className="w-36"
                aria-label={t("toolbar.visibleHours")}
                data-testid="calendar-range-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBLE_RANGE_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={option.id}
                    data-testid={`calendar-range-${option.id}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {isGridView ? (
            <div
              className="border-input flex items-center rounded-md border"
              role="group"
              aria-label={t("toolbar.zoom")}
            >
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-r-none"
                aria-label={t("toolbar.zoomOut")}
                data-testid="calendar-zoom-out"
                disabled={zoomIndex === 0}
                onClick={() => {
                  zoomBy(-1);
                }}
              >
                <ZoomOut className="size-4" />
              </Button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground w-12 text-xs tabular-nums"
                title={t("toolbar.resetZoomHint")}
                aria-label={t("toolbar.resetZoom")}
                data-testid="calendar-zoom-level"
                onClick={resetZoom}
              >
                {f.percent(pxPerMinute)}
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-l-none"
                aria-label={t("toolbar.zoomIn")}
                data-testid="calendar-zoom-in"
                disabled={zoomIndex === ZOOM_LEVELS.length - 1}
                onClick={() => {
                  zoomBy(1);
                }}
              >
                <ZoomIn className="size-4" />
              </Button>
            </div>
          ) : null}

          <Tabs
            value={view}
            onValueChange={(next) => {
              navigate({ view: isCalendarView(next) ? next : "week" });
            }}
          >
            <TabsList>
              {CALENDAR_VIEWS.map((candidate) => (
                <TabsTrigger
                  key={candidate}
                  value={candidate}
                  data-testid={`calendar-view-${candidate}`}
                >
                  {tc(`time.${candidate}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label={
                undoChange === null
                  ? t("toolbar.undo")
                  : t("toolbar.undoChange", { change: undoChange })
              }
              title={
                undoChange === null
                  ? t("toolbar.undoHint")
                  : t("toolbar.undoChangeHint", { change: undoChange })
              }
              data-testid="calendar-undo"
              disabled={!history.canUndo}
              onClick={history.undo}
            >
              <Undo2 className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={
                redoChange === null
                  ? t("toolbar.redo")
                  : t("toolbar.redoChange", { change: redoChange })
              }
              title={
                redoChange === null
                  ? t("toolbar.redoHint")
                  : t("toolbar.redoChangeHint", { change: redoChange })
              }
              data-testid="calendar-redo"
              disabled={!history.canRedo}
              onClick={history.redo}
            >
              <Redo2 className="size-4" />
            </Button>
          </div>

          <Button
            size="sm"
            data-testid="calendar-add-entry"
            onClick={openBlankDraft}
          >
            <Plus className="size-4" />
            {t("toolbar.addEntry")}
          </Button>
        </div>
      </div>

      {isGridView ? (
        <TimeGrid
          days={gridDays}
          entries={entries}
          isLoading={isLoading}
          actions={actions}
          preferredRange={preferredRange}
          pxPerMinute={pxPerMinute}
          onZoomBy={zoomBy}
        />
      ) : view === "month" ? (
        <MonthView
          month={new Date(anchorMs)}
          entries={entries}
          isLoading={isLoading}
          weekStartsOn={weekStartsOn}
          onSelectDay={(date) => {
            navigate({ view: "day", date });
          }}
        />
      ) : (
        <YearView
          year={new Date(anchorMs)}
          weekStartsOn={weekStartsOn}
          onSelectDay={(date) => {
            navigate({ view: "day", date });
          }}
        />
      )}

      <EntryCreateDialog
        draft={draft}
        actions={actions}
        onClose={() => {
          setDraft(null);
        }}
      />
    </div>
  );
}
