"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/use-t";
import { useFormat } from "@/i18n/use-format";

type MemberRateEditorProps = {
  rate: number | null | undefined; canEdit: boolean; busy: boolean; onSave: (rate: number | null) => void;
};

export function MemberRateEditor({ rate, canEdit, busy, onSave }: MemberRateEditorProps): React.JSX.Element {
  const t = useT("approvals");
  const f = useFormat();
  if (rate === undefined) return <span>{t("hidden")}</span>;
  if (!canEdit) return <span>{rate === null ? t("inherit") : f.number(rate)}</span>;
  return <MemberRateForm key={rate ?? "inherit"} rate={rate} busy={busy} onSave={onSave} />;
}

function MemberRateForm({ rate, busy, onSave }: Pick<MemberRateEditorProps, "busy" | "onSave"> & { rate: number | null }): React.JSX.Element {
  const t = useT("approvals");
  const [draft, setDraft] = React.useState(rate === null ? "" : String(rate));
  const parsed = draft.trim() === "" ? null : Number(draft.replace(",", "."));
  const valid = parsed === null || Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000;
  return <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(parsed); }}>
    <Input aria-label={t("rate")} inputMode="decimal" value={draft} placeholder={t("inherit")} className="w-28" disabled={busy} onChange={(event) => setDraft(event.target.value)} />
    <Button size="sm" variant="outline" type="submit" disabled={busy || !valid || parsed === rate}>{t("save")}</Button>
  </form>;
}
