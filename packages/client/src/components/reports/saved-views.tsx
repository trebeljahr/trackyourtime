"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/workspace-switcher";
import { useTrackedSpan } from "@/lib/entry-links";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { getKnownWorkspacesOwner } from "@/lib/active-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import { reportsHref, parseReportView } from "@/lib/report-links";
import { createSavedReportStore, reportStorageKey, savedReportQuery, savedReportStorage, resolveSavedReportQuery, type ReportStorageIdentity, type SavedReportView } from "@/lib/saved-report-views";
import type { UseReportFiltersResult } from "./use-report-filters";

export function SavedReportViews({ filters }: { filters: UseReportFiltersResult }): React.JSX.Element | null {
  const { user } = useAuth();
  const { activeId } = useActiveWorkspace();
  const owner = getKnownWorkspacesOwner();
  if (!user || !activeId || (owner !== null && owner !== user.id)) return null;
  const identity = { userId: user.id, workspaceId: activeId, server: getAbsoluteApiOrigin() };
  // A scope switch unmounts the whole draft and every pending storage callback.
  return <SavedViewsBody key={reportStorageKey(identity)} identity={identity} filters={filters} />;
}

function SavedViewsBody({ identity, filters }: { identity: ReportStorageIdentity; filters: UseReportFiltersResult }): React.JSX.Element {
  const t = useT("reports");
  const router = useRouter();
  const params = useSearchParams();
  const trackedSpan = useTrackedSpan();
  const [store] = React.useState(() => createSavedReportStore(identity, savedReportStorage()));
  const [views, setViews] = React.useState<SavedReportView[]>([]);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [selected, setSelected] = React.useState("");
  const [name, setName] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const live = React.useRef(true);
  const busy = React.useRef(false);
  React.useEffect(() => {
    live.current = true;
    let cancelled = false;
    void store.load().then((rows) => {
      if (cancelled) return;
      setViews(rows); setReady(true); setFailed(false);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; live.current = false; };
  }, [store, retry]);

  const write = async (next: SavedReportView[], nextSelected: string): Promise<void> => {
    if (!ready || busy.current) return;
    busy.current = true; setPending(true);
    try {
      await store.write(next);
      if (live.current) {
        setViews(next); setSelected(nextSelected);
        if (!nextSelected) setName("");
        toast.success(t("saved.saved"));
      }
    } catch {
      if (live.current) toast.error(t("saved.writeFailed"));
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  };
  const load = (view: SavedReportView): void => {
    try {
      const query = resolveSavedReportQuery(view, filters.weekStartsOn, new Date(), undefined, trackedSpan);
      router.push(reportsHref(parseReportView(new URLSearchParams(query).get("view")), query), { scroll: false });
    } catch { toast.error(t("saved.rangeUnavailable")); }
  };
  const label = name.trim();
  const duplicate = views.some((view) => view.id !== selected && view.name.toLocaleLowerCase() === label.toLocaleLowerCase());
  const canName = label.length > 0 && label.length <= 80 && !duplicate;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="saved-report-views">
      <select className="h-9 max-w-60 rounded-md border bg-background px-2 text-sm" aria-label={t("saved.label")} value={selected} disabled={!ready || pending}
        onChange={(event) => {
          const view = views.find((row) => row.id === event.target.value);
          setSelected(view?.id ?? ""); setName(view?.name ?? "");
          if (view) load(view);
        }} data-testid="saved-report-select">
        <option value="">{t("saved.label")}</option>
        {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!ready || pending || !selected} data-testid="saved-report-load" onClick={() => {
        const view = views.find((row) => row.id === selected);
        if (!view) return;
        load(view);
      }}>{t("saved.load")}</Button>
      <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={t("saved.name")} aria-label={t("saved.name")} className="w-44" disabled={!ready || pending} data-testid="saved-report-name" />
      <Button size="sm" variant="outline" disabled={!ready || pending || !canName || views.length >= 50 || views.some((view) => view.name.toLocaleLowerCase() === label.toLocaleLowerCase())}
        onClick={() => {
          const id = crypto.randomUUID();
          const query = params.toString() || "preset=thisWeek";
          void write([...views, { id, name: label, query: savedReportQuery(query, filters.state.range) }], id);
        }} data-testid="saved-report-save">{t("saved.saveCurrent")}</Button>
      <Button size="sm" variant="ghost" disabled={!ready || pending || !selected || !canName}
        onClick={() => void write(views.map((view) => view.id === selected ? { ...view, name: label } : view), selected)} data-testid="saved-report-rename">{t("saved.rename")}</Button>
      <Button size="sm" variant="ghost" disabled={!ready || pending || !selected}
        onClick={() => void write(views.filter((view) => view.id !== selected), "")} data-testid="saved-report-delete">{t("saved.delete")}</Button>
      {!ready && !failed ? <span role="status" className="text-sm text-muted-foreground">{t("saved.loading")}</span> : null}
      {failed ? <span role="alert" className="text-sm">{t("saved.loadFailed")} <Button size="sm" variant="link" onClick={() => { setFailed(false); setRetry((value) => value + 1); }}>{t("saved.retry")}</Button></span> : null}
      {duplicate ? <span role="alert" className="text-sm">{t("saved.duplicate")}</span> : null}
    </div>
  );
}
