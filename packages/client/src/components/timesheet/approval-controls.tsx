"use client";
import * as React from "react";
import { useIsMutating } from "@tanstack/react-query";
import type { TimesheetApprovalWire } from "@starter/shared";
import { trpc } from "@/lib/trpc";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";
import { getHeldCount, refreshPendingCount, isOnline } from "@/lib/offline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { userErrorMessage } from "@/lib/error-message";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { entryMutationScope, sameEntryMutationScope } from "@/lib/entry-mutation-result";
import { getApiOrigin } from "@/lib/api-origin";
import { useAuth } from "@/hooks/use-auth";

export function periodIsLocked(records: readonly TimesheetApprovalWire[]): boolean {
  return records.some((record) => !["draft", "rejected"].includes(record.status));
}
function ApprovalRecord({ record, review }: { record: TimesheetApprovalWire; review: boolean }): React.JSX.Element {
  const t = useT("approvals");
  const fmt = useFormatSettings();
  const f = useFormat();
  const [entryPage, setEntryPage] = React.useState(0);
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const utils = trpc.useUtils();
  const [reason, setReason] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const entries = trpc.approvals.entries.useQuery({ workspaceId: workspace?.id, id: record.id, page: entryPage }, { enabled: expanded });
  const action = trpc.approvals.act.useMutation({
    onSuccess: () => { setReason(""); void utils.invalidate(); },
    onError: (error) => toast.error(userErrorMessage(error)),
  });
  const act = (kind: "withdraw" | "approve" | "reject" | "reopen"): void => {
    action.mutate({ workspaceId: workspace?.id, id: record.id, revision: record.revision, action: kind, reason });
  };
  const status = ["draft", "submitted", "approved", "rejected"].includes(record.status) ? record.status as "draft" | "submitted" | "approved" | "rejected" : "unknown";
  return <article className="space-y-2 rounded-md border p-3" data-testid="approval-record">
    <p className="font-medium">{review ? `${record.authorName || t("formerMember")} · ` : ""}{t("zoneSnapshot", { week: record.weekStart, zone: record.timeZone })} · {t(status)}</p>
    <p>{t("total", { duration: fmt.duration(record.totalSec) })}</p>
    {record.history.at(-1)?.reason ? <p>{record.history.at(-1)?.reason}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => setExpanded(!expanded)}>{t(expanded ? "close" : "entries")}</Button>
      {record.status === "submitted" && record.authorId === user?.id ? <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => act("withdraw")}>{t("withdraw")}</Button> : null}
      {review && ["submitted", "approved"].includes(record.status) ? <>
        <Input aria-label={t("reason")} placeholder={t("reason")} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} className="max-w-md" />
        {record.status === "submitted" ? <>
          <Button size="sm" disabled={action.isPending} onClick={() => act("approve")}>{t("approve")}</Button>
          <Button size="sm" variant="outline" disabled={action.isPending || !reason.trim()} onClick={() => act("reject")}>{t("reject")}</Button>
        </> : <Button size="sm" variant="outline" disabled={action.isPending || !reason.trim()} onClick={() => act("reopen")}>{t("reopen")}</Button>}
      </> : null}
    </div>
    {expanded ? <div className="space-y-1 text-sm">
      {entries.isError ? <p role="alert">{userErrorMessage(entries.error)}</p> : null}
      {entries.data?.entries.length === 0 ? <p>{t("noEntries")}</p> : null}
      {entries.data?.entries.map((entry) => <p key={entry.id}>{f.date(entry.start, { timeZone: record.timeZone, dateStyle: "short", timeStyle: "short" })} · {entry.description} · {fmt.duration(entry.durationSec)}</p>)}
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={entryPage === 0} onClick={() => setEntryPage(entryPage - 1)}>{t("previous")}</Button><Button size="sm" variant="outline" disabled={!entries.data?.hasMore} onClick={() => setEntryPage(entryPage + 1)}>{t("next")}</Button></div>
    </div> : null}
  </article>;
}

type ApprovalControlsProps = {
  weekStart: string; records: TimesheetApprovalWire[]; canReview: boolean; busy: boolean;
};

export function ApprovalControls(props: ApprovalControlsProps): React.JSX.Element {
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const scope = JSON.stringify([user?.id, workspace?.id, props.weekStart, getApiOrigin()]);
  return <ScopedApprovalControls key={scope} {...props} />;
}

function ScopedApprovalControls({ weekStart, records, canReview, busy }: ApprovalControlsProps): React.JSX.Element {
  const t = useT("approvals");
  const queue = useOfflineQueueState();
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const utils = trpc.useUtils();
  const mutating = useIsMutating();
  const [confirmation, setConfirmation] = React.useState<{ scope: string; records: TimesheetApprovalWire[] } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const scope = JSON.stringify([user?.id, workspace?.id, weekStart, getApiOrigin()]);
  const scopeRef = React.useRef(scope);
  React.useLayoutEffect(() => { scopeRef.current = scope; }, [scope]);
  const confirmed = confirmation?.scope === scope && confirmation.records === records;
  const mounted = React.useRef(true);
  React.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [reviewPage, setReviewPage] = React.useState(0);
  const review = trpc.approvals.reviewQueue.useQuery({ workspaceId: workspace?.id, page: reviewPage }, { enabled: canReview });
  const submit = trpc.approvals.submit.useMutation({
    onSuccess: () => { void utils.invalidate(); },
    onError: (error) => toast.error(userErrorMessage(error)),
  });
  const pending = checking || !user?.id || !workspace?.id || !queue.online || queue.pending > 0 || queue.held > 0 || queue.isFlushing || queue.authBlocked || busy || mutating > 0;
  const handleSubmit = async (): Promise<void> => {
    if (pending || !confirmed) return;
    const identity = entryMutationScope();
    if (identity.owner !== user?.id || identity.workspaceId !== workspace?.id) { toast.error(t("pending")); return; }
    const origin = getApiOrigin();
    const stillCurrent = (): boolean => mounted.current && scopeRef.current === scope && getApiOrigin() === origin && sameEntryMutationScope(identity);
    setChecking(true);
    try {
      const queued = await refreshPendingCount();
      if (!stillCurrent()) return;
      if (!isOnline() || queued > 0 || getHeldCount() > 0) { toast.error(t("pending")); return; }
      await submit.mutateAsync({ workspaceId: workspace!.id, weekStart, confirmedOnline: true, pendingLocalEdits: false });
      if (stillCurrent()) setConfirmation(null);
    } catch {
      // Mutation errors are shown by onError; keep confirmation and local work.
    } finally {
      if (mounted.current) setChecking(false);
    }
  };
  return <section className="space-y-3" data-testid="approval-controls">
    <h2 className="font-semibold">{t("title")}</h2>
    {records.map((record) => <ApprovalRecord key={record.id} record={record} review={false} />)}
    {periodIsLocked(records) ? <p>{t("locked")}</p> : <>
      <p className="text-sm">{t("draft")}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmation(event.target.checked ? { scope, records } : null)} />{t("confirm")}</label>
      <Button disabled={pending || !confirmed || submit.isPending} onClick={() => void handleSubmit()}>{t("submit")}</Button>
      {pending ? <p className="text-sm text-muted-foreground">{t("pending")}</p> : null}
    </>}
    {canReview ? <section className="space-y-3 border-t pt-4">
      <h2 className="font-semibold">{t("queue")}</h2>
      {review.isError ? <p role="alert">{userErrorMessage(review.error)}</p> : null}
      {review.data?.records.length === 0 ? <p>{t("emptyQueue")}</p> : null}
      {review.data?.records.map((record) => <ApprovalRecord key={record.id} record={record} review />)}
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={reviewPage === 0} onClick={() => setReviewPage(reviewPage - 1)}>{t("previous")}</Button><Button size="sm" variant="outline" disabled={!review.data?.hasMore} onClick={() => setReviewPage(reviewPage + 1)}>{t("next")}</Button></div>
    </section> : null}
  </section>;
}
