"use client";

import * as React from "react";
import { entryFieldsFrom, type EntryFields } from "@starter/core";

export type EntryFieldsState = {
  fields: EntryFields;
  setFields: (next: EntryFields) => void;
};

/**
 * Buffered entry fields for a dialog or popover, reseeded when it reopens.
 *
 * The reseed happens during render rather than in an effect, on purpose: the
 * dialogs are opened onto a specific entry, and an effect would paint the
 * PREVIOUS entry's values for one frame before correcting itself. `resetKey`
 * is whatever identifies "a different thing is being edited now" — an entry
 * id for the edit surfaces, the open flag for the create ones.
 *
 * Surfaces that write through on every change (the entry rows, the tracker bar
 * while a timer runs) hold no buffer and do not use this.
 */
export const useEntryFields = (
  seed: () => EntryFields,
  resetKey: unknown,
): EntryFieldsState => {
  const [fields, setFields] = React.useState<EntryFields>(seed);
  const [lastKey, setLastKey] = React.useState(resetKey);

  if (lastKey !== resetKey) {
    setLastKey(resetKey);
    setFields(seed());
  }

  return { fields, setFields };
};

/** What a live entry looks like to the write-through surfaces. */
export type WriteThroughEntry = {
  id: string;
  description: string;
  clientId?: string | null;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  tagIds: string[];
};

export type WriteThroughFields = {
  fields: EntryFields;
  onChange: (next: EntryFields, patch: Partial<EntryFields>) => void;
  /** Blur / Enter on the description. No-op when nothing was typed. */
  commitDescription: () => void;
};

/**
 * Fields for a surface that saves as you go — an entry row, the calendar
 * popover, the tracker bar with a timer running.
 *
 * Every field commits the moment it changes, except the description: it is
 * typed rather than picked, and a write per keystroke would put a mutation
 * (and a history step) behind every letter. It commits on blur or Enter
 * instead, which is why this returns a `commitDescription` for the caller to
 * hand to the editor.
 *
 * The local copy exists only so the description has somewhere to be while it
 * is being typed and so the pickers stay responsive ahead of the server; it is
 * reseeded whenever the entry itself changes, so an edit made on another
 * device — or a drag on the same one — is adopted rather than overwritten.
 */
export const useWriteThroughEntryFields = (
  entry: WriteThroughEntry,
  commit: (patch: Partial<EntryFields>) => void,
): WriteThroughFields => {
  const [fields, setFields] = React.useState<EntryFields>(() =>
    entryFieldsFrom(entry),
  );

  const [lastEntry, setLastEntry] = React.useState(entry);
  if (lastEntry !== entry) {
    setLastEntry(entry);
    setFields(entryFieldsFrom(entry));
  }

  const onChange = React.useCallback(
    (next: EntryFields, patch: Partial<EntryFields>): void => {
      setFields(next);
      // The description rides along in `patch` on every keystroke; everything
      // else in it was picked, toggled or cleared exactly once.
      const rest: Partial<EntryFields> = { ...patch };
      delete rest.description;
      if (Object.keys(rest).length > 0) commit(rest);
    },
    [commit],
  );

  const commitDescription = React.useCallback((): void => {
    if (fields.description === entry.description) return;
    commit({ description: fields.description });
  }, [commit, entry.description, fields.description]);

  return { fields, onChange, commitDescription };
};
