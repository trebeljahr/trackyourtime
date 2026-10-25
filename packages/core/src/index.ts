// Framework-free trackyourtime logic. Shared by the web client, the Electron and
// Capacitor shells, and the planned Raycast + Chrome extension clients —
// keep this package free of React, Next and any DOM-only assumption.

export * from "@starter/shared";

export * from "./ids.js";
export * from "./storage.js";
export * from "./timer-store.js";
export * from "./offline-queue.js";
export * from "./offline-ops.js";
export * from "./offline-replay.js";
export * from "./offline-recovery.js";
export * from "./offline-overlay.js";
export * from "./quick-start.js";
export * from "./sync-client.js";
export * from "./sync-url.js";
export * from "./api-client.js";
export * from "./session-auth.js";
export * from "./server-origin.js";
export * from "./server-level.js";
export * from "./idle.js";
export * from "./entry-fields.js";
export * from "./entry-shape.js";
export * from "./timer-echo.js";
export * from "./versioned-storage.js";
export * from "./stored-entry.js";
export * from "./stored-catalog.js";
export * from "./timer-toggle.js";
export * from "./workspace-context.js";
export * from "./activity/index.js";

export { assertEntryClientSupported } from "./api-client.js";

export * from "./durable-entry.js";
export * from "./privacy/crypto.js";
export * from "./privacy/records.js";
export * from "./privacy/recovery.js";
export * from "./privacy/storage.js";
export * from "./privacy/device.js";
export * from "./privacy/workspace-edits.js";
export * from "./privacy/replica.js";
export * from "./privacy/segmented-storage.js";
export * from "./privacy/directory.js";
export * from "./privacy/migration-proof.js";
export * from "./privacy/recovery-backup.js";
export * from "./privacy/recovery-backup-job.js";
export * from "./privacy/initial-snapshot.js";
export * from "./privacy/history-chain.js";

export * from "./privacy/recovery-supplement.js";
export * from "./privacy/combined-recovery.js";
export * from "./privacy/combined-recovery-backup.js";
export * from "./privacy/combined-migration-proof.js";
export * from "./privacy/personal-migration-proof.js";
export * from "./privacy/source-challenge.js";
export * from "./privacy/projection-snapshot.js";
export * from "./privacy/projection-migration-proof.js";

export * from "./privacy/projection-delivery.js";
