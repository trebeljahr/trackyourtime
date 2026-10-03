"use client";

import * as React from "react";
import { Clock, ListChecks, Loader2, Table2 } from "lucide-react";
import {
  type BulkEditEntriesInput,
  type BulkEditEntriesResult,
} from "@starter/shared";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { CURRENCY_FALLBACK_ICON, currencyIcon } from "@/lib/currency";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { userErrorMessage } from "@/lib/error-message";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/workspace-switcher";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { useServerSupports } from "@/lib/server-level";
import { bulkFailures, selectableBulkEntries } from "./bulk-selection";
import { ProjectFormDialog } from "@/components/catalog/project-form-dialog";
import {
  CLIENT_LIST_INPUT,
  PROJECT_LIST_INPUT,
  type ProjectRow,
} from "@/components/catalog/types";
import { BulkActionBar } from "@/components/reports/bulk-action-bar";
import {
  DEFAULT_DETAILED_SORT,
  DetailedTable,
  sortDetailedEntries,
  type DetailedSort,
  type DetailedSortField,
  type SortDirection,
} from "@/components/reports/detailed-table";
import { KpiRow, type KpiItem } from "@/components/reports/kpi-row";
import { formatReportAmounts } from "@/components/reports/report-money";
import { MoneyHiddenNote } from "@/components/reports/member-reporting";
import {
  KpiRowSkeleton,
  TableSkeleton,
} from "@/components/reports/report-skeletons";
import {
  REPORT_PARAM,
  type ReportViewProps,
} from "@/components/reports/use-report-filters";

const PAGE_SIZE = 50;

/**
 * Reports → Entries: every entry in the filtered range, sortable, editable in
 * bulk, one page at a time.
 */
export function EntriesView({
  filters,
  onExportReady,
}: ReportViewProps): React.JSX.Element {
  const { filters: reportFilters, getParam, setParams } = filters;
  const fmt = useFormatSettings();
  const f = useFormat();
  const t = useT("reports");
  const tc = useT("common");
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const { activeId } = useActiveWorkspace();
  const server = getAbsoluteApiOrigin();
  const supportsBulk = useServerSupports("entries.bulkEdit");
  const scopeKey = JSON.stringify([user?.id, activeId, server]);

  const input = React.useMemo(
    () => ({ ...reportFilters, limit: PAGE_SIZE }),
    [reportFilters]
  );

  const query = trpc.reports.detailed.useInfiniteQuery(input, {
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
    staleTime: 15_000,
  });

  // The export covers the whole filtered range server-side, so it only waits
  // for the first answer rather than for every page.
  const exportReady = !query.isPending;
  // A layout effect, so a view whose report is already cached enables the
  // export before the first paint after a switch rather than one frame later.
  React.useLayoutEffect(() => {
    onExportReady(exportReady);
  }, [exportReady, onExportReady]);

  const projectsQuery = trpc.projects.list.useQuery(PROJECT_LIST_INPUT);
  // Only for the project dialog a row's Project cell opens.
  const clientsQuery = trpc.clients.list.useQuery(CLIENT_LIST_INPUT, {
    staleTime: 30_000,
  });
  const [editingProject, setEditingProject] = React.useState<ProjectRow | null>(
    null,
  );
  const openProject = React.useCallback(
    (projectId: string): void => {
      const project = (projectsQuery.data ?? []).find(
        (row) => row.id === projectId,
      );
      if (project) setEditingProject(project);
    },
    [projectsQuery.data, setEditingProject],
  );

  // ── sorting (URL-backed, applied to the loaded pages) ──────────────
  const sortField = getParam(REPORT_PARAM.sort);
  const sortDir = getParam(REPORT_PARAM.dir);
  const sort = React.useMemo<DetailedSort>(
    () => ({
      field: sortField === "duration" ? "duration" : DEFAULT_DETAILED_SORT.field,
      direction: sortDir === "asc" ? "asc" : DEFAULT_DETAILED_SORT.direction,
    }),
    [sortDir, sortField]
  );

  const handleSort = React.useCallback(
    (field: DetailedSortField): void => {
      const nextDirection: SortDirection =
        sort.field === field && sort.direction === "desc" ? "asc" : "desc";
      setParams({
        [REPORT_PARAM.sort]: field === "date" ? null : field,
        [REPORT_PARAM.dir]: nextDirection === "desc" ? null : nextDirection,
      });
    },
    [setParams, sort.direction, sort.field]
  );

  const pages = React.useMemo(() => query.data?.pages ?? [], [query.data]);
  const loadedEntries = React.useMemo(
    () => pages.flatMap((page) => page.entries),
    [pages]
  );
  const entries = React.useMemo(
    () => sortDetailedEntries(loadedEntries, sort),
    [loadedEntries, sort]
  );
  const totals = pages[0];

  // ── selection ──────────────────────────────────────────────────────
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set()
  );

  // A filter change reloads a different set of rows, so a selection made
  // against the old set must not survive it.
  const filterKey = JSON.stringify([scopeKey, reportFilters]);
  const [lastFilterKey, setLastFilterKey] = React.useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    if (selected.size > 0) setSelected(new Set());
  }

  const eligible = React.useMemo(() => selectableBulkEntries(loadedEntries, user?.id ?? null, activeId), [loadedEntries, user?.id, activeId]);
  const eligibleIds = React.useMemo(() => new Set(eligible.map((entry) => entry.id)), [eligible]);
  const toggle = React.useCallback((id: string, isSelected: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (isSelected && eligibleIds.has(id) && next.size < 100) next.add(id);
      else next.delete(id);
      return next;
    });
  }, [eligibleIds, setSelected]);

  const toggleAll = React.useCallback(
    (isSelected: boolean): void => {
      setSelected(
        isSelected ? new Set(eligible.slice(0, 100).map((entry) => entry.id)) : new Set()
      );
    },
    [eligible, setSelected]
  );

  // One server request validates every target; no optimistic partial rewrite.
  const editEntries = trpc.entries.bulkEdit.useMutation();
  const [bulkPending, setBulkPending] = React.useState(false);
  const [bulkResult, setBulkResult] = React.useState<{ key: string; result: BulkEditEntriesResult } | null>(null);
  const currentKey = React.useRef(filterKey);
  React.useLayoutEffect(() => { currentKey.current = filterKey; }, [filterKey]);
  const busy = React.useRef(false);

  const runBulk = (operation: BulkEditEntriesInput["operation"]): void => {
    if (!supportsBulk || busy.current || !activeId || !user || selected.size === 0) return;
    const requestKey = filterKey;
    const targets = loadedEntries.filter((entry) => selected.has(entry.id));
    if (targets.length !== selected.size) return;
    busy.current = true; setBulkPending(true); setBulkResult(null);
    void (async () => {
      try {
        const result = await editEntries.mutateAsync({
          workspaceId: activeId, originId: ORIGIN_ID, operation,
          entries: targets.map((entry) => ({ id: entry.id, expectedUpdatedAt: entry.updatedAt })),
        });
        if (currentKey.current !== requestKey) return;
        setSelected(bulkFailures(result));
        setBulkResult({ key: requestKey, result });
        const succeeded = result.results.filter((row) => row.success).length;
        if (succeeded) toast.success(t("bulk.updated", { count: succeeded }));
        if (succeeded !== result.results.length) toast.error(t("bulk.partial"));
        void utils.reports.invalidate(); void utils.entries.invalidate();
      } catch (error) {
        if (currentKey.current === requestKey) {
          toast.error(userErrorMessage(error, t("detailed.toast.failed")));
          // The connection may have failed after writes committed. Keep every
          // target selected and reload revisions before offering a retry.
          void utils.reports.invalidate(); void utils.entries.invalidate();
        }
      } finally {
        busy.current = false; setBulkPending(false);
      }
    })();
  };
  const handleSetProject = (projectId: string | null): void => runBulk({ kind: "update", projectId });
  const handleSetBillable = (billable: boolean): void => runBulk({ kind: "update", billable });
  const handleDelete = (): void => runBulk({ kind: "delete" });

  const kpis = React.useMemo<KpiItem[]>(
    () => [
      {
        label: t("kpi.totalTracked"),
        value: fmt.duration(totals?.totalSec ?? 0),
        hint: t("kpi.wholeRange"),
        icon: Clock,
        testId: "kpi-total",
      },
      {
        label: t("kpi.amountEarned"),
        value: formatReportAmounts(
          totals?.totalAmounts,
          totals?.totalAmount ?? (totals ? null : 0),
          totals?.currency ?? fmt.currency,
          fmt.money,
        ),
        hint: totals?.totalAmounts?.map((bucket) => bucket.currency).join(" · ") || totals?.currency || fmt.currency,
        icon: (totals?.totalAmounts?.length ?? 0) > 1
          ? CURRENCY_FALLBACK_ICON
          : currencyIcon(totals?.currency ?? fmt.currency) ?? CURRENCY_FALLBACK_ICON,
        testId: "kpi-amount",
      },
      {
        label: t("kpi.entriesLoaded"),
        value: f.number(entries.length),
        hint: query.hasNextPage ? t("kpi.moreAvailable") : t("kpi.allInRange"),
        icon: ListChecks,
        testId: "kpi-entries",
      },
    ],
    [entries.length, f, fmt, query.hasNextPage, t, totals]
  );

  const isLoading = query.isPending;

  return (
    <div className="space-y-4" data-testid="detailed-report">
      {isLoading ? <KpiRowSkeleton /> : <KpiRow items={kpis} />}
      <MoneyHiddenNote moneyVisible={totals?.moneyVisible} />

      {eligible.length > 100 ? <p className="text-sm text-muted-foreground" data-testid="bulk-selection-limit">{t("bulk.selectFirst", { count: f.number(100) })}</p> : null}
      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <TableSkeleton
              rows={8}
              columns={6}
              testId="detailed-table-skeleton"
            />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={Table2}
              title={t("detailed.emptyTitle")}
              description={t("detailed.emptyDescription")}
              testId="detailed-empty"
            />
          ) : (
            <DetailedTable
              entries={entries}
              selected={selected}
              selectableIds={eligibleIds}
              selectionPending={bulkPending}
              maxSelection={100}
              onToggle={toggle}
              onToggleAll={toggleAll}
              sort={sort}
              onSort={handleSort}
              duration={fmt.duration}
              money={fmt.money}
              clock={fmt.clock}
              onEditProject={openProject}
            />
          )}

          {query.hasNextPage ? (
            <div className="flex justify-center pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
                data-testid="detailed-load-more"
              >
                {query.isFetchingNextPage ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t("detailed.loadMore")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {!supportsBulk ? <p role="status" className="text-sm text-muted-foreground">{t("bulk.serverTooOld")}</p> : null}
      {bulkResult?.key === filterKey && bulkResult.result.results.some((row) => !row.success) ? (
        <div role="alert" className="space-y-1 text-sm" data-testid="bulk-failures">
          <p>{t("bulk.partial")}</p>
          <ul>{bulkResult.result.results.filter((row) => !row.success).map((row) => (
            <li key={row.id}>{loadedEntries.find((entry) => entry.id === row.id)?.description || tc("empty.noDescription")}: {row.success ? "" : t(`bulk.reasons.${row.reason}`)}</li>
          ))}</ul>
        </div>
      ) : null}
      {selected.size > 0 ? (
        <BulkActionBar
          count={selected.size}
          pending={bulkPending || !supportsBulk}
          onClear={() => setSelected(new Set())}
          onSetProject={handleSetProject}
          onSetBillable={handleSetBillable}
          onDelete={handleDelete}
          onEditLabels={(patch) => runBulk({ kind: "update", ...patch })}
        />
      ) : null}

      <ProjectFormDialog
        open={editingProject !== null}
        onOpenChange={(next) => {
          if (!next) setEditingProject(null);
        }}
        project={editingProject}
        clients={clientsQuery.data ?? []}
      />

      {query.isError ? (
        <p className="text-sm text-destructive" data-testid="detailed-error">
          {userErrorMessage(query.error, undefined, tc)}
        </p>
      ) : null}
    </div>
  );
}
