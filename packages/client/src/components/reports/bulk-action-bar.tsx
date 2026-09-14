"use client";

import * as React from "react";
import { Loader2, Trash2, X } from "lucide-react";

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
}: BulkActionBarProps): React.JSX.Element {
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
        onClick={onClear}
        data-testid="bulk-clear"
      >
        <X className="size-4" />
        {t("bulk.clearSelection")}
      </Button>

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
