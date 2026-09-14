"use client";

import * as React from "react";
import { Loader2, Undo2 } from "lucide-react";
import type { ImportBatchSummary } from "@starter/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { translate } from "@/i18n/translate";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";

/**
 * Undoing an import is a bulk delete, so it asks first — and it asks the one
 * question the user cannot answer from the row: whether the projects and tags
 * the file invented should go with the entries.
 */
function UndoDialog(props: {
  batch: ImportBatchSummary | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { batch, onOpenChange } = props;
  const utils = trpc.useUtils();
  const t = useT("settings");
  const [includeCatalog, setIncludeCatalog] = React.useState(true);

  const undo = trpc.data.undo.useMutation({
    onSuccess: (result) => {
      const tr = translate("settings");
      toast.success(
        result.projectsDeleted > 0
          ? tr("data.history.toasts.undoneWithProjects", {
              count: result.entriesDeleted,
              projects: result.projectsDeleted,
            })
          : tr("data.history.toasts.undone", { count: result.entriesDeleted }),
      );
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        userErrorMessage(error, translate("settings")("data.history.toasts.undoFailed")),
      );
    },
    onSettled: () => {
      void utils.entries.invalidate();
      void utils.reports.invalidate();
      void utils.clients.invalidate();
      void utils.projects.invalidate();
      void utils.tasks.invalidate();
      void utils.tags.invalidate();
      void utils.data.history.invalidate();
    },
  });

  return (
    <Dialog open={batch !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="import-undo-dialog">
        <DialogHeader>
          <DialogTitle>{t("data.history.undo.title")}</DialogTitle>
          <DialogDescription>
            {batch === null
              ? ""
              : batch.filename
                ? t("data.history.undo.description", {
                    count: batch.entriesCreated,
                    filename: batch.filename,
                  })
                : t("data.history.undo.descriptionUnnamed", {
                    count: batch.entriesCreated,
                  })}
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            {t("data.history.undo.includeCatalog")}
            <span className="block text-xs text-muted-foreground">
              {t("data.history.undo.includeCatalogHint")}
            </span>
          </span>
          <Switch
            checked={includeCatalog}
            onCheckedChange={setIncludeCatalog}
            data-testid="import-undo-catalog"
          />
        </label>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t("data.history.undo.keep")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={undo.isPending || !batch}
            onClick={() => {
              if (!batch) return;
              undo.mutate({
                batchId: batch.batchId,
                includeCatalog,
                originId: ORIGIN_ID,
              });
            }}
            data-testid="import-undo-confirm"
          >
            {undo.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Undo2 className="size-4" />
            )}
            {t("data.history.undo.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Past imports, so a mapping mistake found next week is still reversible. */
export function ImportHistory(): React.JSX.Element | null {
  const query = trpc.data.history.useQuery({});
  const [undoing, setUndoing] = React.useState<ImportBatchSummary | null>(null);
  const t = useT("settings");
  const tc = useT("common");
  const f = useFormat();

  if (query.isPending) {
    return <Skeleton className="h-32 w-full" />;
  }
  // Nothing imported yet is not a state worth a card of its own.
  if (!query.data || query.data.length === 0) return null;

  return (
    <Card data-testid="import-history">
      <CardHeader>
        <CardTitle>{t("data.history.title")}</CardTitle>
        <CardDescription>{t("data.history.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("data.history.columns.file")}</TableHead>
                <TableHead>{t("data.history.columns.imported")}</TableHead>
                <TableHead className="text-right">{tc("fields.entries")}</TableHead>
                <TableHead className="text-right">{tc("fields.time")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((batch) => (
                <TableRow key={batch.batchId}>
                  <TableCell className="max-w-56 truncate font-medium">
                    {batch.filename ?? t("data.history.unnamedFile")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {f.date(batch.createdAt, "medium")}
                  </TableCell>
                  <TableCell className="text-right">
                    {f.number(batch.entriesCreated)}
                  </TableCell>
                  <TableCell className="text-right">
                    {f.durationShort(batch.totalSec)}
                  </TableCell>
                  <TableCell className="text-right">
                    {batch.undoneAt ? (
                      <Badge variant="secondary">{t("data.history.undone")}</Badge>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setUndoing(batch)}
                        data-testid={`import-undo-${batch.batchId}`}
                      >
                        <Undo2 className="size-4" />
                        {tc("actions.undo")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <UndoDialog
        batch={undoing}
        onOpenChange={(open) => {
          if (!open) setUndoing(null);
        }}
      />
    </Card>
  );
}
