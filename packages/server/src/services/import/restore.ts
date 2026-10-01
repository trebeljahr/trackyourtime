// The non-entry half of a workspace export, on the way back IN.
//
// Entries and catalog are the import's whole job; settings and pins are the
// difference between "your history is here" and "your workspace is back". The
// deciding is done here, pure — no database, no request — so the rules can be
// tested without one, and so the router is left with nothing but the writes.
//
// What is NOT here is as deliberate as what is: invoices are export-only (see
// `WorkspaceExportInvoice` for the four reasons), and the per-user half of
// settings is keyed by userId rather than workspaceId, so a workspace file
// writing it would reconfigure the importer in every OTHER workspace too.
import {
  MAX_FAVORITES,
  quickStartKey,
  type QuickStart,
  type WeekStart,
  type WorkspaceExport,
  type WorkspaceExportFavorite,
} from "@starter/shared";

/** The workspace settings fields a file may write, as a `$set` would take them. */
export type WorkspaceSettingsRestore = {
  defaultHourlyRate?: number;
  currency?: string;
  weekStartsOn?: WeekStart;
};

/**
 * What of the workspace's money and calendar policy this file actually states.
 *
 * A field the file does not state is LEFT OUT rather than defaulted: an import
 * that filled the gaps with this app's own defaults would quietly reprice a
 * workspace to 0/hour because the file it was handed predated settings, or was
 * redacted. `defaultHourlyRate: null` is exactly that case — see
 * `WorkspaceExportSettings`, where null is "not said" and never "free".
 *
 * `currency` is read from the document's top level, which is where it lives;
 * the settings section deliberately does not repeat it.
 */
export function settingsRestoreFields(
  document: WorkspaceExport,
): WorkspaceSettingsRestore {
  const fields: WorkspaceSettingsRestore = {};

  // Currency is read outside the settings section, and so is restorable from
  // a v1 file that has no such section: it has been at the document's top
  // level since the first version of this format, and it is the field that
  // decides what every entry written afterwards is denominated in.
  const currency = document.currency.trim();
  if (currency !== "") fields.currency = currency;

  const settings = document.settings;
  if (!settings) return fields;

  if (typeof settings.defaultHourlyRate === "number") {
    fields.defaultHourlyRate = settings.defaultHourlyRate;
  }
  if (settings.weekStartsOn === 0 || settings.weekStartsOn === 1) {
    fields.weekStartsOn = settings.weekStartsOn;
  }

  return fields;
}

/** One pin as it would be written, with its slot in the caller's row. */
export type PlannedFavorite = QuickStart & { order: number };

export type FavoriteRestorePlan = {
  create: PlannedFavorite[];
  /** Pins the caller already has under the same quick-start key. */
  duplicates: number;
  /** Pins dropped because the row is full at {@link MAX_FAVORITES}. */
  overflow: number;
};

/**
 * Decide which of a file's pins to write, and where they go.
 *
 * Three rules, each of which fails quietly if dropped:
 *
 *  - Deduped on `quickStartKey`, exactly as `favorites.create` does, or
 *    re-importing the same backup doubles every pin.
 *  - Appended after the pins already there, dense from the caller's next
 *    slot. The file's own `order` is relative to a workspace this one knows
 *    nothing about, so writing it through would collide with existing pins
 *    and leave the row in an order nobody chose.
 *  - Capped at {@link MAX_FAVORITES}, the same ceiling the router enforces.
 *    The overflow is counted rather than written, so the import can say the
 *    row was full instead of silently exceeding a limit.
 *
 * A pin whose project name does not resolve in the destination is kept with
 * `projectId: null` rather than dropped: "the thing I do every morning" with
 * no project is a perfectly good pin, and dropping it loses a row the user
 * would never know had been in the file.
 */
export function planFavoriteRestore(args: {
  favorites: readonly WorkspaceExportFavorite[];
  /** The caller's pins in the destination workspace. */
  existing: readonly QuickStart[];
  /** Names → ids in the DESTINATION workspace; unresolved reads as null. */
  resolve: (favorite: WorkspaceExportFavorite) => {
    clientId?: string | null;
    projectId: string | null;
    taskId: string | null;
  };
}): FavoriteRestorePlan {
  const { favorites, existing, resolve } = args;
  const plan: FavoriteRestorePlan = { create: [], duplicates: 0, overflow: 0 };

  const taken = new Set(existing.map(quickStartKey));
  let next = existing.length;

  // The file's own order decides which pins make the cut when the row fills
  // up, so it is honoured as a SEQUENCE even though its numbers are not.
  const ordered = [...favorites].sort((a, b) => a.order - b.order);

  for (const favorite of ordered) {
    const { clientId, projectId, taskId } = resolve(favorite);
    const quick: QuickStart = {
      description: favorite.description.trim().slice(0, 500),
      ...(clientId !== undefined ? { clientId } : {}),
      projectId,
      // A task without its project addresses nothing: task names are unique
      // within a project, so a resolved task id is only meaningful with one.
      taskId: projectId ? taskId : null,
      billable: favorite.billable,
    };

    const key = quickStartKey(quick);
    if (taken.has(key)) {
      plan.duplicates += 1;
      continue;
    }
    if (next >= MAX_FAVORITES) {
      plan.overflow += 1;
      continue;
    }

    taken.add(key);
    plan.create.push({ ...quick, order: next });
    next += 1;
  }

  return plan;
}
