// Browser-local User Timing only; never persisted or sent to a telemetry SDK.
const prefix = "tyt:";
const marks = ["login-submitted", "authentication-ready", "tracker-useful-data-ready"] as const;
const measures = ["startup-to-auth", "startup-to-tracker", "login-to-auth", "login-to-tracker", "auth-to-tracker"] as const;
type Part = "current" | "entries" | "projects";
const ready = new Set<Part>();

function timing(): Performance | null {
  return typeof window !== "undefined" && typeof window.performance?.mark === "function"
    ? window.performance : null;
}

export function resetStartupTiming(): void {
  ready.clear();
  const perf = timing();
  if (!perf) return;
  for (const mark of marks) perf.clearMarks(prefix + mark);
  for (const measure of measures) perf.clearMeasures(prefix + measure);
}

export function markLoginSubmitted(): void {
  resetStartupTiming();
  timing()?.mark(prefix + "login-submitted");
}

function hasMark(perf: Performance, name: string): boolean {
  return perf.getEntriesByName(prefix + name, "mark").length > 0;
}

function markTrackerReady(): void {
  const perf = timing();
  if (!perf || ready.size !== 3 || !hasMark(perf, "authentication-ready") || hasMark(perf, "tracker-useful-data-ready")) return;
  perf.mark(prefix + "tracker-useful-data-ready");
  perf.measure(prefix + "startup-to-tracker", { start: 0, end: prefix + "tracker-useful-data-ready" });
  perf.measure(prefix + "auth-to-tracker", prefix + "authentication-ready", prefix + "tracker-useful-data-ready");
  if (hasMark(perf, "login-submitted")) {
    perf.measure(prefix + "login-to-tracker", prefix + "login-submitted", prefix + "tracker-useful-data-ready");
  }
}

export function markAuthenticationReady(): void {
  const perf = timing();
  if (!perf || hasMark(perf, "authentication-ready")) return;
  perf.mark(prefix + "authentication-ready");
  perf.measure(prefix + "startup-to-auth", { start: 0, end: prefix + "authentication-ready" });
  if (hasMark(perf, "login-submitted")) {
    perf.measure(prefix + "login-to-auth", prefix + "login-submitted", prefix + "authentication-ready");
  }
  markTrackerReady();
}

export function trackerDataReady(part: Part, successful: boolean): void {
  if (successful) ready.add(part); else ready.delete(part);
  markTrackerReady();
}
