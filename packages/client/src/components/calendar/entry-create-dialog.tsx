"use client";

import * as React from "react";
import { emptyEntryFields } from "@starter/core";
import { parseTimeOfDay } from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntryFieldsEditor } from "@/components/entry-fields/entry-fields-editor";
import { useEntryFields } from "@/components/entry-fields/use-entry-fields";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import { formatDayLabel, useFormatSettings } from "@/lib/format";
import type { CalendarActions } from "./use-calendar-entries";

/** The times a drag on empty space produced. */
export type CreateDraft = {
  start: string;
  end: string;
};

export type EntryCreateDialogProps = {
  draft: CreateDraft | null;
  actions: CalendarActions;
  onClose: () => void;
};

/**
 * Prefilled "new entry" dialog. Opens from a drag on empty grid space, and
 * from the toolbar's "Add entry" button.
 */
export function EntryCreateDialog({
  draft,
  actions,
  onClose,
}: EntryCreateDialogProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("calendar");
  const tc = useT("common");

  const { fields, setFields } = useEntryFields(emptyEntryFields, draft);
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");

  // A fresh draft resets the times too; editing mid-draft is never clobbered.
  const [lastDraft, setLastDraft] = React.useState<CreateDraft | null>(null);
  if (draft !== null && lastDraft !== draft) {
    setLastDraft(draft);
    setStart(format.clock(draft.start));
    setEnd(format.clock(draft.end));
  }

  const submit = (): void => {
    if (!draft) return;
    const startIso = parseTimeOfDay(start, draft.start);
    const endIso = parseTimeOfDay(end, draft.start);
    if (startIso === null || endIso === null) {
      toast.error(t("create.invalidTimes"));
      return;
    }
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      toast.error(t("create.endBeforeStart"));
      return;
    }

    actions.create({
      ...fields,
      start: startIso,
      end: endIso,
    });
    onClose();
  };

  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="calendar-create-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>
            {draft ? formatDayLabel(draft.start, format.locale) : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <EntryFieldsEditor
            value={fields}
            onChange={setFields}
            autoFocus
            descriptionPlaceholder={t("create.descriptionPlaceholder")}
            onSubmit={submit}
            idPrefix="calendar-create"
            testIdPrefix="calendar-create"
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="calendar-create-start">{tc("fields.start")}</Label>
              <Input
                id="calendar-create-start"
                data-testid="calendar-create-start"
                className="tabular-nums"
                value={start}
                onChange={(event) => {
                  setStart(event.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="calendar-create-end">{tc("fields.end")}</Label>
              <Input
                id="calendar-create-end"
                data-testid="calendar-create-end"
                className="tabular-nums"
                value={end}
                onChange={(event) => {
                  setEnd(event.target.value);
                }}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="calendar-create-cancel"
            onClick={onClose}
          >
            {tc("actions.cancel")}
          </Button>
          <Button data-testid="calendar-create-submit" onClick={submit}>
            {t("create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
