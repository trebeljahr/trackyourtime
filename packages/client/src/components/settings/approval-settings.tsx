"use client";
import * as React from "react";
import { trpc } from "@/lib/trpc";
import { useServerSupports } from "@/lib/server-level";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useT } from "@/i18n/use-t";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { userErrorMessage } from "@/lib/error-message";

export function ApprovalSettings(): React.JSX.Element | null {
  const supports = useServerSupports("timesheets.approvals");
  const { workspace } = useActiveWorkspace();
  const policy = trpc.approvals.policy.useQuery({ workspaceId: workspace?.id }, { enabled: supports && !!workspace });
  if (!supports || !workspace || !policy.data?.canConfigure) return null;
  const current = policy.data;
  return <ApprovalSettingsForm
    key={JSON.stringify([workspace.id, current.enabled, current.requireApprovedForInvoices, current.timeZone])}
    workspaceId={workspace.id} canViewMoney={workspace.permissions.viewOthersMoney} policy={current}
  />;
}

function ApprovalSettingsForm({ workspaceId, canViewMoney, policy }: {
  workspaceId: string; canViewMoney: boolean;
  policy: { enabled: boolean; requireApprovedForInvoices: boolean; timeZone: string; transactionsSupported: boolean };
}): React.JSX.Element {
  const t = useT("approvals");
  const utils = trpc.useUtils();
  const [enabled, setEnabled] = React.useState(policy.enabled);
  const [required, setRequired] = React.useState(policy.requireApprovedForInvoices);
  const [zone, setZone] = React.useState(policy.timeZone);
  const save = trpc.approvals.configure.useMutation({ onSuccess: () => { toast.success(t("saved")); void utils.invalidate(); }, onError: (error) => toast.error(userErrorMessage(error)) });
  const available = policy.transactionsSupported;
  return <section className="space-y-3 border-t pt-4" data-testid="approval-settings">
    <h3 className="font-semibold">{t("title")}</h3>
    <p className="text-sm text-muted-foreground">{t("configureHint")}</p>
    {!available ? <p>{t("transactions")}</p> : null}
    <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={!available || save.isPending} onChange={(event) => { setEnabled(event.target.checked); if (!event.target.checked) setRequired(false); }} />{t("enable")}</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={required} disabled={!available || !enabled || save.isPending || !canViewMoney} onChange={(event) => setRequired(event.target.checked)} />{t("invoicePolicy")}</label>
    <label className="block space-y-1"><span>{t("zone")}</span><Input value={zone} disabled={!available || save.isPending} onChange={(event) => setZone(event.target.value)} placeholder="Europe/Berlin" /></label>
    <Button disabled={!available || save.isPending} onClick={() => save.mutate({ workspaceId, enabled, requireApprovedForInvoices: required, timeZone: zone })}>{t("save")}</Button>
  </section>;
}
