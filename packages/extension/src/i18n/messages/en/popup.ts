/**
 * English `popup` — the SOURCE catalog for the browser extension's popup (every screen under src/popup).
 *
 * Add keys here, then in ../de/popup.ts (`tsc` enforces parity). ICU syntax as
 * in the web client. Reuse the web client's German terms
 * (packages/client/src/i18n/GLOSSARY.de.md) so the two surfaces agree.
 */
export const popup = {
  workspace: {
    label: "Workspace",
    heldTitle: "{count, plural, one {# change} other {# changes}} not sent",
    heldHint: "Queued in a workspace your account no longer belongs to. They are not sent to any other workspace. Ask an owner to add you back to sync them, or discard them here.",
    leftWorkspace: "a workspace you left",
    untitled: "(no description)",
    discard: "Discard",
    discardHint: "This deletes work tracked in {workspace} that no server has received. It cannot be recovered.",
    ops: {
      start: "Start “{description}” in {workspace}",
      stop: "Stop in {workspace}",
      create: "Add “{description}” in {workspace}",
      update: "Edit “{description}” in {workspace}",
      remove: "Delete an entry in {workspace}",
      other: "A change in {workspace}",
    },
  },
} as const;
