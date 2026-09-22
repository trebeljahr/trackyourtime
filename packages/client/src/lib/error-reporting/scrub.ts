import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/browser";

import { isChunkLoadError } from "@/lib/chunk-reload";

/**
 * What an error report may carry, decided in one place and tested without the
 * SDK. Every rule here removes something; nothing adds data.
 *
 * The policy, which the privacy page states in plain words:
 *
 *  - No person. `user` is dropped whole, and `sendDefaultPii` stays off, so
 *    the SDK never asks the tracker to keep an IP address either.
 *  - No query string and no fragment, anywhere a URL appears: the page
 *    address, every stack frame, every breadcrumb and any URL inside an error
 *    message. `/invite/?id=`, `/app/device/?user_code=` and `?next=` carry
 *    values that are close to secrets, and a tRPC GET puts its whole input,
 *    descriptions included, into `?input=`.
 *  - No headers but the browser identifier, no cookies, no request body.
 *  - No console output and no clicks or keystrokes in breadcrumbs: a console
 *    line can hold anything, and a DOM breadcrumb names the element that was
 *    typed into. Only fetch, XHR and navigation breadcrumbs survive, reduced
 *    to method, status and a stripped URL.
 *  - Email addresses and bearer tokens inside a message are replaced. A server
 *    refusal can name the address it refused.
 */

/** The only `contexts` keys a report keeps: what the SDK derives from the browser identifier, plus the trace ids it uses to group events. */
const KEPT_CONTEXTS: ReadonlySet<string> = new Set(["browser", "os", "device", "runtime", "trace"]);

/** The only breadcrumb categories a report keeps. */
const KEPT_BREADCRUMBS: ReadonlySet<string> = new Set(["fetch", "xhr", "navigation"]);

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
/** `?` or `#` and everything after it, inside a longer text. Stops at whitespace and quotes. */
const QUERY_IN_TEXT = /[?#][^\s"'<>]*/g;
/**
 * A URL (absolute, or a root-relative path) inside a longer text. The path
 * stops at a quote or bracket; a query string or fragment, once begun, runs
 * to the next whitespace, so a tRPC `?input={"a":1}` is removed whole rather
 * than cut at its first quote with the rest left in the message.
 */
const URL_IN_TEXT = /(?:\b[a-z][\w+.-]*:\/\/|(?<![\w.])\/)[^\s"'<>?#]*(?:[?#]\S*)?/gi;

/**
 * A URL with its query string, fragment and any `user:password@` removed.
 * Works on absolute URLs, root-relative paths and the `app://-` origin alike,
 * because it never parses — a URL that fails to parse is still stripped.
 */
export function stripUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const bare = cut === -1 ? url : url.slice(0, cut);
  return bare.replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** Free text (an error message) with URLs stripped, email addresses and bearer tokens replaced. */
export function scrubText(text: string): string {
  // URLs first: stripping one removes any `user:password@` before the email
  // rule could half-match it, and any address that was only in its query.
  return text
    .replace(BEARER, "Bearer [redacted]")
    .replace(URL_IN_TEXT, (url) => stripUrl(url))
    .replace(QUERY_IN_TEXT, (rest) => (rest.includes("=") ? "" : rest))
    .replace(EMAIL, "[email]");
}

/**
 * One breadcrumb reduced to what is safe to send, or `null` to drop it.
 * Also the SDK's `beforeBreadcrumb`, so a dropped one is never even stored.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category ?? "";
  if (!KEPT_BREADCRUMBS.has(category)) return null;
  const data = breadcrumb.data ?? {};
  const kept: Record<string, unknown> = {};
  if (category === "navigation") {
    if (typeof data.from === "string") kept.from = stripUrl(data.from);
    if (typeof data.to === "string") kept.to = stripUrl(data.to);
  } else {
    if (typeof data.method === "string") kept.method = data.method;
    if (typeof data.status_code === "number") kept.status_code = data.status_code;
    if (typeof data.url === "string") kept.url = stripUrl(data.url);
  }
  return {
    type: breadcrumb.type,
    category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    data: kept,
  };
}

/** An error event with everything outside the policy above removed. Mutates and returns it. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  delete event.extra;
  delete event.server_name;

  if (event.request) {
    const userAgent = event.request.headers?.["User-Agent"];
    event.request = {
      ...(event.request.url ? { url: stripUrl(event.request.url) } : {}),
      ...(userAgent ? { headers: { "User-Agent": userAgent } } : {}),
    };
  }

  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!KEPT_CONTEXTS.has(key)) delete event.contexts[key];
    }
  }

  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  if (event.logentry) delete event.logentry.params;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = stripUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = stripUrl(frame.abs_path);
      delete frame.vars;
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }

  return event;
}

/** Tag value that marks a chunk error the reload-once guard already refused to reload. */
export const CHUNK_RELOAD_REFUSED = "refused";

/**
 * Whether an event is noise that must not be sent.
 *
 * A failed chunk load on the web is what every tab left open across a deploy
 * produces, and `lib/chunk-reload.ts` answers it with one reload. Only the case
 * the reload did not fix is worth a report, and the code that knows that tags
 * the event it captures with `chunk_reload: refused`. The same failure caught
 * by the SDK's own global handler carries no tag and is dropped. In a shell the
 * chunks ship inside the app, so a missing one is a real bug and is kept.
 */
export function shouldDropEvent(
  event: ErrorEvent,
  hint: EventHint,
  { appShell }: { appShell: boolean },
): boolean {
  if (appShell) return false;
  if (event.tags?.chunk_reload === CHUNK_RELOAD_REFUSED) return false;
  const values = event.exception?.values ?? [];
  return (
    isChunkLoadError(hint.originalException) ||
    values.some((value) => isChunkLoadError({ name: value.type, message: value.value }))
  );
}
