"use client";

import * as React from "react";
import { zoneLabel, type DetailedEntry } from "@starter/shared";

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
import { DurationInput } from "@/components/duration-input";
import { EntryFieldsEditor } from "@/components/entry-fields/entry-fields-editor";
import { TimeField } from "@/components/tracker/time-field";
import { useEntryEditor } from "@/components/tracker/use-entry-editor";
import type { EntryMutations } from "@/components/tracker/use-entry-mutations";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";

export type EntryEditDialogProps = {
  /** The entry being edited; `null` closes the dialog. */
  entry: DetailedEntry | null;
  onClose: () => void;
  mutations: EntryMutations;
};

/**
 * Full editor for one entry — the escape hatch for the changes the inline
 * fields cannot express, mainly moving a block to another day.
 *
 * Every rule about what a save writes lives in `use-entry-editor.ts`, which is
 * where the timezone re-anchoring and the midnight roll are documented and
 * unit-tested. This file is the dialog around it and nothing more.
 */
export function EntryEditDialog({
  entry,
  onClose,
  mutations,
}: EntryEditDialogProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("tracker");
  const tc = useT("common");
  const editor = useEntryEditor(entry, {
    onSave: mutations.updateEntry,
    onDone: onClose,
  });

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="entry-edit-dialog">
        <DialogHeader>
          <DialogTitle>{t("editDialog.title")}</DialogTitle>
          <DialogDescription>{t("editDialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <EntryFieldsEditor
            value={editor.fields}
            onChange={editor.setFields}
            idPrefix="entry-edit"
            testIdPrefix="entry-edit"
          />

          {editor.foreignZone ? (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              data-testid="entry-edit-zone-note"
            >
              {t("editDialog.zoneNote", {
                zoneLabel: zoneLabel(editor.entryZone),
                zone: editor.entryZone,
              })}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <div className="flex-1 space-y-2">
              <Label htmlFor="entry-edit-date">{t("fields.startDate")}</Label>
              <Input
                id="entry-edit-date"
                type="date"
                value={editor.startDayKey}
                onChange={(event) => editor.changeStartDay(event.target.value)}
                data-testid="entry-edit-date"
              />
            </div>

            {/* An entry that ran past midnight ends on a different day, and
                there was no way to see or set that. */}
            <div className="flex-1 space-y-2">
              <Label htmlFor="entry-edit-end-date">{t("fields.endDate")}</Label>
              <Input
                id="entry-edit-end-date"
                type="date"
                value={editor.endDayKey}
                min={editor.startDayKey}
                onChange={(event) => editor.changeEndDay(event.target.value)}
                data-testid="entry-edit-end-date"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>{tc("fields.start")}</Label>
              <TimeField
                value={editor.start}
                timeFormat={format.timeFormat}
                timeZone={editor.entryZone}
                aria-label={t("fields.startTime")}
                testId="entry-edit-start"
                onCommit={editor.setStart}
              />
            </div>
            <div className="space-y-2">
              <Label>{tc("fields.end")}</Label>
              <TimeField
                value={editor.end}
                timeFormat={format.timeFormat}
                timeZone={editor.entryZone}
                disabled={editor.isRunning}
                aria-label={t("fields.endTime")}
                testId="entry-edit-end"
                onCommit={editor.setEnd}
              />
            </div>
            <div className="space-y-2">
              <Label>{tc("fields.duration")}</Label>
              <DurationInput
                value={editor.seconds}
                format={format.durationFormat}
                disabled={editor.isRunning}
                aria-label={tc("fields.duration")}
                testId="entry-edit-duration"
                onCommit={editor.setDurationSeconds}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            data-testid="entry-edit-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={editor.save}
            data-testid="entry-edit-save"
          >
            {tc("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
