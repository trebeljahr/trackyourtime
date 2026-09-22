import type { Breadcrumb, ErrorEvent } from "@sentry/browser";
import { describe, expect, it } from "vitest";

import {
  CHUNK_RELOAD_REFUSED,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  shouldDropEvent,
  stripUrl,
} from "./scrub";

describe("stripUrl", () => {
  it("drops the query string and fragment of every kind of address the app has", () => {
    expect(stripUrl("https://trackyourtime.dev/invite/?id=abc123")).toBe("https://trackyourtime.dev/invite/");
    expect(stripUrl("https://trackyourtime.dev/app/device/?user_code=WXYZ-1234#x")).toBe(
      "https://trackyourtime.dev/app/device/",
    );
    expect(stripUrl("/login/?next=%2Fapp%2Fsettings")).toBe("/login/");
    expect(stripUrl("app://-/app/track/#top")).toBe("app://-/app/track/");
    expect(stripUrl("capacitor://localhost/app/track/")).toBe("capacitor://localhost/app/track/");
  });

  it("drops credentials in the authority", () => {
    expect(stripUrl("https://user:secret@api.example.com/x")).toBe("https://api.example.com/x");
  });
});

describe("scrubText", () => {
  it("replaces email addresses and bearer tokens", () => {
    expect(scrubText("No account for jane.doe+work@example.co.uk here")).toBe("No account for [email] here");
    expect(scrubText("Authorization: Bearer abc.DEF-123_=")).toBe("Authorization: Bearer [redacted]");
  });

  it("strips query strings from URLs and paths inside a message", () => {
    expect(
      scrubText('fetch failed: https://api.trackyourtime.dev/api/trpc/entries.list?batch=1&input={"a":1} (500)'),
    ).toBe("fetch failed: https://api.trackyourtime.dev/api/trpc/entries.list (500)");
    expect(scrubText("redirect to /invite/?id=deadbeef failed")).toBe("redirect to /invite/ failed");
    expect(scrubText("see https://u:p@host.example/a?email=a@b.co")).toBe("see https://host.example/a");
  });

  it("leaves ordinary messages alone", () => {
    const message = "Minified React error #418; Cannot read properties of undefined (reading 'id')";
    expect(scrubText(message)).toBe(message);
    expect(scrubText("Loading chunk 12 failed. (error: /_next/static/chunks/12.js)")).toBe(
      "Loading chunk 12 failed. (error: /_next/static/chunks/12.js)",
    );
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console, click and keypress breadcrumbs, whatever they hold", () => {
    expect(scrubBreadcrumb({ category: "console", message: "user jane@example.com" })).toBeNull();
    expect(scrubBreadcrumb({ category: "ui.click", message: "input[name=email]" })).toBeNull();
    expect(scrubBreadcrumb({ category: "ui.input", message: "input#description" })).toBeNull();
    expect(scrubBreadcrumb({ message: "no category" })).toBeNull();
  });

  it("keeps method, status and a stripped URL of a request, and nothing else", () => {
    const crumb: Breadcrumb = {
      type: "http",
      category: "fetch",
      timestamp: 1,
      data: {
        method: "GET",
        status_code: 401,
        url: "https://api.trackyourtime.dev/api/trpc/entries.list?input=%7B%22description%22%3A%22x%22%7D",
        request_body_size: 10,
        response_body_size: 20,
      },
    };
    expect(scrubBreadcrumb(crumb)).toEqual({
      type: "http",
      category: "fetch",
      level: undefined,
      timestamp: 1,
      data: { method: "GET", status_code: 401, url: "https://api.trackyourtime.dev/api/trpc/entries.list" },
    });
  });

  it("strips both ends of a navigation", () => {
    const crumb = scrubBreadcrumb({
      category: "navigation",
      data: { from: "/login/?next=/app/device/?user_code=ABCD", to: "/app/device/?user_code=ABCD" },
    });
    expect(crumb?.data).toEqual({ from: "/login/", to: "/app/device/" });
  });
});

const baseEvent = (): ErrorEvent => ({
  type: undefined,
  event_id: "e",
  message: "Invite for jane@example.com failed",
  user: { id: "u1", email: "jane@example.com", ip_address: "203.0.113.9", username: "Jane" },
  extra: { body: "anything" },
  request: {
    url: "https://trackyourtime.dev/invite/?id=secret#frag",
    query_string: "id=secret",
    cookies: { "better-auth.session_token": "tok" },
    data: { password: "hunter2" },
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://trackyourtime.dev/login/?next=/invite/?id=secret",
      Authorization: "Bearer tok",
      Cookie: "better-auth.session_token=tok",
    },
  },
  contexts: {
    browser: { name: "Chrome" },
    os: { name: "macOS" },
    trace: { trace_id: "t", span_id: "s" },
    form: { email: "jane@example.com" },
  },
  exception: {
    values: [
      {
        type: "TRPCClientError",
        value: "No user jane@example.com at https://api.trackyourtime.dev/api/trpc/x?input=1",
        stacktrace: {
          frames: [
            {
              filename: "https://trackyourtime.dev/_next/static/chunks/app.js?dpl=abc",
              abs_path: "https://trackyourtime.dev/_next/static/chunks/app.js?dpl=abc",
              vars: { email: "jane@example.com" },
            },
          ],
        },
      },
    ],
  },
  breadcrumbs: [
    { category: "console", message: "jane@example.com" },
    { category: "navigation", data: { from: "/", to: "/invite/?id=secret" } },
  ],
});

describe("scrubEvent", () => {
  it("removes the person, the body, cookies, headers but the browser identifier, and every query string", () => {
    const event = scrubEvent(baseEvent());
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.request).toEqual({
      url: "https://trackyourtime.dev/invite/",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    expect(Object.keys(event.contexts ?? {}).sort()).toEqual(["browser", "os", "trace"]);
    expect(event.message).toBe("Invite for [email] failed");
    const exception = event.exception?.values?.[0];
    expect(exception?.value).toBe("No user [email] at https://api.trackyourtime.dev/api/trpc/x");
    expect(exception?.stacktrace?.frames?.[0]).toEqual({
      filename: "https://trackyourtime.dev/_next/static/chunks/app.js",
      abs_path: "https://trackyourtime.dev/_next/static/chunks/app.js",
    });
    expect(event.breadcrumbs).toEqual([
      { type: undefined, category: "navigation", level: undefined, timestamp: undefined, data: { from: "/", to: "/invite/" } },
    ]);
  });

  it("leaves nothing that looks like an email, a token or a secret query value anywhere in the event", () => {
    const serialized = JSON.stringify(scrubEvent(baseEvent()));
    expect(serialized).not.toMatch(/jane@example\.com/);
    expect(serialized).not.toMatch(/secret/);
    expect(serialized).not.toMatch(/tok\b/);
    expect(serialized).not.toMatch(/hunter2/);
    expect(serialized).not.toMatch(/203\.0\.113\.9/);
  });
});

describe("shouldDropEvent", () => {
  const chunkEvent = (tags?: Record<string, string>): ErrorEvent => ({
    type: undefined,
    tags,
    exception: { values: [{ type: "ChunkLoadError", value: "Loading chunk 12 failed." }] },
  });

  it("drops a web chunk error the reload-once guard is handling", () => {
    expect(shouldDropEvent(chunkEvent(), {}, { appShell: false })).toBe(true);
    expect(
      shouldDropEvent({ type: undefined }, { originalException: new TypeError("Failed to fetch dynamically imported module: /a.js") }, { appShell: false }),
    ).toBe(true);
  });

  it("keeps one the guard refused, and every chunk error in a shell", () => {
    expect(shouldDropEvent(chunkEvent({ chunk_reload: CHUNK_RELOAD_REFUSED }), {}, { appShell: false })).toBe(false);
    expect(shouldDropEvent(chunkEvent(), {}, { appShell: true })).toBe(false);
  });

  it("keeps any other error", () => {
    const event: ErrorEvent = { type: undefined, exception: { values: [{ type: "TypeError", value: "x is undefined" }] } };
    expect(shouldDropEvent(event, { originalException: new TypeError("x is undefined") }, { appShell: false })).toBe(false);
  });
});
