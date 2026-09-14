"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import { ClientFormDialog } from "@/components/catalog/client-form-dialog";
import { ProjectFormDialog } from "@/components/catalog/project-form-dialog";
import { TaskFormDialog } from "@/components/catalog/task-form-dialog";
import type {
  ClientRow,
  ProjectRow,
  TaskRow,
} from "@/components/catalog/types";
import { DateRangePicker } from "@/components/date-range-picker";
import { useTrackedSpan } from "@/lib/entry-links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/reports/multi-select";
import { TagFilter } from "@/components/tags/tag-filter";
import { MemberFilter } from "@/components/reports/member-reporting";
import {
  type BillableFilter,
  type UseReportFiltersResult,
} from "@/components/reports/use-report-filters";

const SEARCH_DEBOUNCE_MS = 350;

/** Debounced description search - one URL write per pause, not per keystroke. */
function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const t = useT("reports");
  const [draft, setDraft] = React.useState(value);
  const [lastValue, setLastValue] = React.useState(value);
  const timer = React.useRef<number | null>(null);

  // Adopt external changes (back/forward, filter reset) without clobbering a
  // value the user is mid-way through typing.
  if (lastValue !== value) {
    setLastValue(value);
    if (timer.current === null) setDraft(value);
  }

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const schedule = React.useCallback(
    (next: string): void => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onChange(next);
      }, SEARCH_DEBOUNCE_MS);
    },
    [onChange]
  );

  const flush = React.useCallback(
    (next: string): void => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      onChange(next);
    },
    [onChange]
  );

  return (
    // A row of its own on a phone: sharing one with Export left the German
    // and pseudo placeholders clipped mid-word.
    <div className="relative w-full sm:w-auto">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draft}
        placeholder={t("filters.searchDescriptions")}
        aria-label={t("filters.searchDescriptions")}
        className="w-full pl-8 sm:w-64"
        onChange={(event) => {
          setDraft(event.target.value);
          schedule(event.target.value);
        }}
        onBlur={() => flush(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            flush(draft);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft("");
            flush("");
          }
        }}
        data-testid="filter-search"
      />
    </div>
  );
}

/**
 * Which catalog dialog is open, and on what. `null` in the `row` slot is a
 * create; a row is an edit. One piece of state, so opening a second dialog can
 * never leave the first one mounted behind it.
 */
type CatalogDialog =
  | null
  | { kind: "client"; row: ClientRow | null }
  | { kind: "project"; row: ProjectRow | null }
  | { kind: "task"; row: TaskRow | null };

export type ReportFiltersBarProps = {
  filters: UseReportFiltersResult;
  /** Rendered at the end, right-aligned - normally `<ExportMenu />`. */
  trailing?: React.ReactNode;
  className?: string;
  /** Offer the member filter — see `useMemberReporting` for who gets it. */
  memberFilter?: boolean;
};

/**
 * The filter bar both report views share. All state lives in the URL, so
 * Totals and Entries stay in step with one another and a report link is
 * shareable.
 */
export function ReportFiltersBar({
  filters,
  trailing,
  className,
  memberFilter = false,
}: ReportFiltersBarProps): React.JSX.Element {
  const {
    state,
    weekStartsOn,
    isFiltered,
    setRange,
    setIds,
    setBillable,
    setSearch,
    clearFilters,
  } = filters;

  const t = useT("reports");
  const tc = useT("common");
  const billableLabel: Record<BillableFilter, string> = {
    all: t("filters.allEntries"),
    yes: tc("fields.billable"),
    no: tc("fields.nonBillable"),
  };

  const trackedSpan = useTrackedSpan();
  const clientsQuery = trpc.clients.list.useQuery({});
  const projectsQuery = trpc.projects.list.useQuery({});
  // Tasks are workspace-wide, so this filter stands on its own: it lists every
  // task whatever the project filter says, and picking one never depends on -
  // or disturbs - the projects beside it.
  const tasksQuery = trpc.tasks.list.useQuery({});

  const clientOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      (clientsQuery.data ?? []).map((client) => ({
        value: client.id,
        label: client.name,
        color: client.color,
      })),
    [clientsQuery.data]
  );

  const projectOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        value: project.id,
        label: project.name,
        color: project.color,
        group: project.clientName ?? tc("empty.noClient"),
      })),
    [projectsQuery.data, tc]
  );

  const taskOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      (tasksQuery.data ?? []).map((task) => ({
        value: task.id,
        label: task.name,
      })),
    [tasksQuery.data]
  );

  // Every filter list doubles as the catalog surface for what it filters by:
  // the same create/edit dialogs the Clients, Projects and Tasks screens use,
  // opened in place so a report that is missing a client does not cost a
  // round trip through another screen and back.
  const [catalogDialog, setCatalogDialog] = React.useState<CatalogDialog>(null);

  const findClient = (id: string): ClientRow | null =>
    (clientsQuery.data ?? []).find((client) => client.id === id) ?? null;

  const findProject = (id: string): ProjectRow | null =>
    (projectsQuery.data ?? []).find((project) => project.id === id) ?? null;

  const findTask = (id: string): TaskRow | null =>
    (tasksQuery.data ?? []).find((task) => task.id === id) ?? null;

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2",
          className
        )}
        data-testid="report-filters"
      >
        <DateRangePicker
          value={state.range}
          onChange={setRange}
          weekStartsOn={weekStartsOn}
          allTime={trackedSpan}
          testId="filter-range"
        />

        <MultiSelect
          label={tc("fields.clients")}
          options={clientOptions}
          value={state.clientIds}
          onChange={(ids) => setIds("clientIds", ids)}
          emptyText={t("filters.clients.empty")}
          searchPlaceholder={t("filters.clients.search")}
          className="w-auto min-w-[9.5rem] max-w-[14rem]"
          testId="filter-clients"
          editLabel={t("filters.clients.edit")}
          onEditOption={(option) =>
            setCatalogDialog({ kind: "client", row: findClient(option.value) })
          }
          footerActions={[
            {
              label: t("filters.clients.create"),
              onSelect: () => setCatalogDialog({ kind: "client", row: null }),
              testId: "filter-clients-new",
            },
          ]}
        />

        <MultiSelect
          label={tc("fields.projects")}
          options={projectOptions}
          value={state.projectIds}
          onChange={(ids) => setIds("projectIds", ids)}
          emptyText={t("filters.projects.empty")}
          searchPlaceholder={t("filters.projects.search")}
          className="w-auto min-w-[9.5rem] max-w-[14rem]"
          testId="filter-projects"
          editLabel={t("filters.projects.edit")}
          onEditOption={(option) =>
            setCatalogDialog({
              kind: "project",
              row: findProject(option.value),
            })
          }
          footerActions={[
            {
              label: t("filters.projects.create"),
              onSelect: () => setCatalogDialog({ kind: "project", row: null }),
              testId: "filter-projects-new",
            },
          ]}
        />

        <MultiSelect
          label={tc("fields.tasks")}
          options={taskOptions}
          value={state.taskIds}
          onChange={(ids) => setIds("taskIds", ids)}
          emptyText={t("filters.tasks.empty")}
          searchPlaceholder={t("filters.tasks.search")}
          className="w-auto min-w-[9.5rem] max-w-[14rem]"
          testId="filter-tasks"
          editLabel={t("filters.tasks.edit")}
          onEditOption={(option) =>
            setCatalogDialog({ kind: "task", row: findTask(option.value) })
          }
          footerActions={[
            {
              label: t("filters.tasks.create"),
              onSelect: () => setCatalogDialog({ kind: "task", row: null }),
              testId: "filter-tasks-new",
            },
          ]}
        />

        <TagFilter
          value={state.tagIds}
          onChange={(ids) => setIds("tagIds", ids)}
        />

        {memberFilter ? (
          <MemberFilter
            value={state.memberIds ?? []}
            onChange={(ids) => setIds("memberIds", ids)}
          />
        ) : null}

        <Select
          value={state.billable}
          onValueChange={(next) => setBillable(next as BillableFilter)}
        >
          <SelectTrigger className="w-auto min-w-[9.5rem] gap-2" data-testid="filter-billable">
            <SelectValue>{billableLabel[state.billable]}</SelectValue>
          </SelectTrigger>
          <SelectContent data-testid="filter-billable-content">
            <SelectItem value="all" data-testid="filter-billable-all">
              {billableLabel.all}
            </SelectItem>
            <SelectItem value="yes" data-testid="filter-billable-yes">
              {billableLabel.yes}
            </SelectItem>
            <SelectItem value="no" data-testid="filter-billable-no">
              {billableLabel.no}
            </SelectItem>
          </SelectContent>
        </Select>

        <SearchField value={state.search} onChange={setSearch} />

        {isFiltered ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="filter-clear"
          >
            <X className="size-4" />
            {tc("actions.clear")}
          </Button>
        ) : null}

        {trailing ? (
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">{trailing}</div>
        ) : null}
      </div>

      {/*
        A create here adds to the catalog but deliberately does not tick itself
        into the filter: a brand-new client has no entries, so selecting it
        would answer "new client" with an empty report.
      */}
      <ClientFormDialog
        open={catalogDialog?.kind === "client"}
        onOpenChange={(next) => {
          if (!next) setCatalogDialog(null);
        }}
        client={catalogDialog?.kind === "client" ? catalogDialog.row : null}
      />

      <ProjectFormDialog
        open={catalogDialog?.kind === "project"}
        onOpenChange={(next) => {
          if (!next) setCatalogDialog(null);
        }}
        project={catalogDialog?.kind === "project" ? catalogDialog.row : null}
        clients={clientsQuery.data ?? []}
      />

      <TaskFormDialog
        open={catalogDialog?.kind === "task"}
        onOpenChange={(next) => {
          if (!next) setCatalogDialog(null);
        }}
        task={catalogDialog?.kind === "task" ? catalogDialog.row : null}
      />
    </>
  );
}
