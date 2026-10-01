import { randomUUID } from "node:crypto";

/** Sentry's event ingestion endpoint; no SDK runs in the Raycast process. */
export function parseDsn(value: string): { endpoint: string; key: string } | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return { endpoint: `${url.origin}${prefix}/api/${project}/store/`, key: decodeURIComponent(url.username) };
  } catch {
    return null;
  }
}

/** Strip values likely to identify a person or a request; never include raw stack text. */
export function scrubErrorText(value: string): string {
  return value
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:\b[a-z][\w+.-]*:\/\/|(?<![\w.])\/)[^\s"'<>?#]*(?:[?#]\S*)?/gi, (url) =>
      url.split(/[?#]/, 1)[0].replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1"),
    )
    .replace(/[?#][^\s"'<>]*/g, "")
    .replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi, "[email]")
    .slice(0, 300);
}

/** Only source names and line numbers from extension frames; no absolute file paths. */
export function safeFrames(
  stack: string | undefined,
): Array<{ filename: string; function?: string; lineno: number; colno: number }> {
  if (!stack) return [];
  const frames = [];
  for (const line of stack.split("\n").slice(1, 11)) {
    const match = line.match(/^\s*at (?:(\S+) \()?[^\s()]*?([\w.-]+\.(?:js|tsx?|mjs)):(\d+):(\d+)\)?$/);
    if (!match) continue;
    frames.push({
      filename: match[2],
      ...(match[1] && /^[\w.$<>-]+$/.test(match[1]) ? { function: match[1] } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
    });
  }
  return frames.reverse();
}

export function createReporter(
  dsn: string,
  release: string,
  buildId: string,
  send: typeof fetch = fetch,
): (error: unknown, source: string) => void {
  const target = parseDsn(dsn);
  if (!target) return () => {};
  return (error, source) => {
    const kind = error instanceof Error && /^[A-Za-z_$][\w$]{0,79}$/.test(error.name) ? error.name : "UnknownError";
    const message = error instanceof Error ? scrubErrorText(error.message) : "Non-Error value thrown";
    const event = {
      event_id: randomUUID().replace(/-/g, ""),
      timestamp: new Date().toISOString(),
      platform: "node",
      level: "error",
      release,
      tags: { platform: "raycast", source: scrubErrorText(source).slice(0, 80), build_id: buildId },
      exception: {
        values: [
          {
            type: kind,
            value: message,
            stacktrace: { frames: safeFrames(error instanceof Error ? error.stack : undefined) },
          },
        ],
      },
    };
    void send(target.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=trackyourtime-raycast/1, sentry_key=${target.key}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  };
}
