"use client";

import * as React from "react";
import type { EntryFields } from "@starter/core";

import { EntryFieldsEditor } from "@/components/entry-fields/entry-fields-editor";
import { useEntryFields } from "@/components/entry-fields/use-entry-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n/use-t";

export type ActivityRuleDialogProps = {
  /** The app the rule is for, or null while the dialog is closed. */
  app: { key: string; name: string } | null;
  /** What the dialog opens on: the suggestion's current proposal. */
  seed: EntryFields;
  onOpenChange: (open: boolean) => void;
  /** Resolves false when main refused the rule; the dialog then stays open. */
  onSave: (pattern: string, fields: EntryFields) => Promise<boolean>;
};

/**
 * "Always file {app} under …": a rule on this computer that proposes these
 * fields for every block the app dominates. The same five fields an entry
 * has, through the same editor every other entry surface uses.
 */
export function ActivityRuleDialog({
  app,
  seed,
  onOpenChange,
  onSave,
}: ActivityRuleDialogProps): React.JSX.Element {
  const t = useT("activity");
  const tc = useT("common");
  const open = app !== null;
  // The getter closes over this render's `seed` directly: `useEntryFields`
  // calls it during render (initial state, and again on a reset), so the
  // value it reads is already the current one — no latest-value ref needed.
  const { fields, setFields } = useEntryFields(() => seed, app?.key ?? null);
  const [saving, setSaving] = React.useState(false);

  const save = React.useCallback(async (): Promise<void> => {
    if (app === null) return;
    setSaving(true);
    const saved = await onSave(app.key, fields).catch(() => false);
    setSaving(false);
    if (saved) onOpenChange(false);
  }, [app, fields, onOpenChange, onSave]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="activity-rule-dialog">
        <DialogHeader>
          <DialogTitle>{t("rule.title", { app: app?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("rule.description", { app: app?.name ?? "" })}</DialogDescription>
        </DialogHeader>

        <EntryFieldsEditor
          value={fields}
          onChange={setFields}
          onSubmit={() => void save()}
          idPrefix="activity-rule"
          testIdPrefix="activity-rule"
        />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="activity-rule-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving} data-testid="activity-rule-save">
            {t("rule.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
