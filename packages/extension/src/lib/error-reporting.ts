import { APP_VERSION, BUILD_ID } from "./app-version";

export type ErrorSource = "popup" | "background";
type ReporterConfig = { endpoint: string; publicKey: string; platform: "chrome" | "firefox" };

// Vite replaces this at build time. Empty builds have no reporting endpoint.
const config: ReporterConfig | null = import.meta.env.VITE_ERROR_REPORTING_CONFIG;
const ERROR_NAMES = new Set(["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError", "EvalError"]);

/** Only fixed fields cross the network. Messages and stacks can contain account data. */
export function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return ERROR_NAMES.has(name) ? name : "Error";
}

export function makeEnvelope(error: unknown, source: ErrorSource, eventId: string, timestamp: string) {
  const event = {
    event_id: eventId,
    timestamp,
    platform: "javascript",
    level: "error",
    release: `trackyourtime@${APP_VERSION}${BUILD_ID ? `+${BUILD_ID}` : ""}`,
    tags: { platform: config?.platform ?? "chrome", source, build_id: BUILD_ID },
    exception: { values: [{ type: safeErrorName(error), value: "Extension error" }] },
  };
  return `${JSON.stringify({ event_id: eventId, sent_at: timestamp })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

export function reportExtensionError(error: unknown, source: ErrorSource): void {
  if (!config) return;
  if (config.platform === "firefox") {
    void chrome.permissions.getAll().then((permissions) => {
      const grants = (permissions as chrome.permissions.Permissions & { data_collection?: string[] }).data_collection;
      if (grants?.includes("technicalAndInteraction")) send(error, source);
    }).catch(() => undefined);
    return;
  }
  send(error, source);
}

function send(error: unknown, source: ErrorSource): void {
  if (!config) return;
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const body = makeEnvelope(error, source, eventId, new Date().toISOString());
  void fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7,sentry_client=trackyourtime-extension/1,sentry_key=${config.publicKey}` },
    body,
  }).catch(() => undefined);
}

/** Attach global handlers when the reporter chunk loads. */
export function startErrorReporting(source: ErrorSource): void {
  if (!config) return;
  globalThis.addEventListener("error", (event) => reportExtensionError(event.error, source));
  globalThis.addEventListener("unhandledrejection", (event) => reportExtensionError(event.reason, source));
}
