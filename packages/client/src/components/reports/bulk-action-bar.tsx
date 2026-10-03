"use client";

import * as React from "react";
import { Loader2, Trash2, X } from "lucide-react";

import type { BulkEditEntriesInput } from "@starter/shared";
import { TaskPicker } from "@/components/task-picker";
import { TagPicker } from "@/components/tags/tag-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { ProjectPicker } from "@/components/project-picker";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";

export type BulkActionBarProps = {
  count: number;
  pending: boolean;
  onClear: () => void;
  onSetProject: (projectId: string | null) => void;
  onSetBillable: (billable: boolean) => void;
  onDelete: () => void;
  onEditLabels: (patch: Omit<Extract<BulkEditEntriesInput["operation"], { kind: "update" }>, "kind">) => void;
};

/**
 * Appears once rows are selected in the detailed report. Deletion is the only
 * irreversible action here, so it goes through a confirmation dialog.
 */
export function BulkActionBar({
  count,
  pending,
  onClear,
  onSetProject,
  onSetBillable,
  onDelete,
  onEditLabels,
}: BulkActionBarProps): React.JSX.Element {
  const [labelsOpen, setLabelsOpen] = React.useState(false);
  const [applyTask, setApplyTask] = React.useState(false);
  const [taskId, setTaskId] = React.useState<string | null>(null);
  const [tagMode, setTagMode] = React.useState<"keep" | "set" | "add" | "remove" | "clear">("keep");
  const [tagIds, setTagIds] = React.useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const t = useT("reports");
  const tc = useT("common");
  const f = useFormat();

  return (
    <div
      className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-lg"
      role="region"
      aria-label={t("bulk.region")}
      data-testid="bulk-action-bar"
    >
      <span className="px-1 text-sm font-medium" data-testid="bulk-count">
        {tc("counts.selected", { count: f.number(count) })}
      </span>

      <Separator orientation="vertical" className="h-6" />

      <ProjectPicker
        value={null}
        onChange={onSetProject}
        allowCreate={false}
        placeholder={t("bulk.setProject")}
        disabled={pending}
        size="sm"
        className="min-w-44"
        testId="bulk-set-project"
      />

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => onSetBillable(true)}
        data-testid="bulk-billable-on"
      >
        {t("bulk.markBillable")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => onSetBillable(false)}
        data-testid="bulk-billable-off"
      >
        {t("bulk.markNonBillable")}
      </Button>

      <Button type="button" variant="outline" size="sm" disabled={pending}
        onClick={() => { setApplyTask(false); setTaskId(null); setTagMode("keep"); setTagIds([]); setLabelsOpen(true); }} data-testid="bulk-edit-labels">
        {t("bulk.editLabels")}
      </Button>
      <span className="text-xs text-muted-foreground">{t("bulk.limit")}</span>

      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={pending}
        onClick={() => setConfirmOpen(true)}
        data-testid="bulk-delete"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
        {tc("actions.delete")}
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto"
        disabled={pending}
        onClick={onClear}
        data-testid="bulk-clear"
      >
        <X className="size-4" />
        {t("bulk.clearSelection")}
      </Button>

      <Dialog open={labelsOpen} onOpenChange={setLabelsOpen}>
        <DialogContent data-testid="bulk-label-dialog">
          <DialogHeader><DialogTitle>{t("bulk.editLabels")}</DialogTitle><DialogDescription>{t("bulk.labelsDescription")}</DialogDescription></DialogHeader>
          <label className="flex items-center gap-2"><Checkbox checked={applyTask} disabled={pending} onCheckedChange={(value) => setApplyTask(value === true)} data-testid="bulk-change-task" />{t("bulk.changeTask")}</label>
          <TaskPicker value={taskId} onChange={setTaskId} disabled={!applyTask || pending} allowCreate={false} testId="bulk-set-task" />
          <p className="text-xs text-muted-foreground">{t("bulk.clearTaskHint")}</p>
          <label className="space-y-1 text-sm"><span>{tc("fields.tags")}</span>
            <select value={tagMode} disabled={pending} onChange={(event) => setTagMode(event.target.value as typeof tagMode)} className="block h-9 w-full rounded-md border bg-background px-2" data-testid="bulk-tag-mode">
              {(["keep", "set", "add", "remove", "clear"] as const).map((mode) => <option key={mode} value={mode}>{t(`bulk.tagModes.${mode}`)}</option>)}
            </select>
          </label>
          {tagMode !== "keep" && tagMode !== "clear" ? <TagPicker value={tagIds} onChange={setTagIds} disabled={pending} testId="bulk-tag-picker" /> : null}
          <DialogFooter>
            <DialogClose asChild><Button variant="outline" disabled={pending}>{tc("actions.cancel")}</Button></DialogClose>
            <Button disabled={pending || (!applyTask && tagMode === "keep") || ((tagMode === "add" || tagMode === "remove") && tagIds.length === 0)} data-testid="bulk-label-apply" onClick={() => {
              const tags = tagMode === "keep" ? undefined : tagMode === "clear" ? { mode: "clear" as const } : { mode: tagMode, ids: tagIds };
              onEditLabels({ ...(applyTask ? { taskId } : {}), ...(tags ? { tags } : {}) });
              setLabelsOpen(false);
            }}>{t("bulk.apply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid="bulk-delete-dialog">
          <DialogHeader>
            <DialogTitle>{t("bulk.confirmTitle", { count })}</DialogTitle>
            <DialogDescription>{t("bulk.confirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                data-testid="bulk-delete-cancel"
              >
                {tc("actions.cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
              data-testid="bulk-delete-confirm"
            >
              {t("bulk.confirm", { count })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
