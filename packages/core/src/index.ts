// Framework-free tracktime logic. Shared by the web client, the Electron and
// Capacitor shells, and the planned Raycast + Chrome extension clients —
// keep this package free of React, Next and any DOM-only assumption.

export * from "@starter/shared";

export * from "./ids.js";
export * from "./storage.js";
export * from "./timer-store.js";
export * from "./offline-queue.js";
export * from "./offline-ops.js";
export * from "./offline-replay.js";
export * from "./offline-overlay.js";
export * from "./quick-start.js";
export * from "./sync-client.js";
export * from "./sync-url.js";
export * from "./api-client.js";
export * from "./session-auth.js";
export * from "./server-origin.js";
export * from "./idle.js";
export * from "./entry-fields.js";
export * from "./entry-shape.js";
export * from "./timer-echo.js";
export * from "./activity/index.js";
