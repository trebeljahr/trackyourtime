import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Sdk from "./sdk";

let sdkImported = false;
vi.mock("@sentry/browser", () => {
  sdkImported = true;
  return {};
});

const { createErrorReporter, releaseName, startErrorReporting, reportClientError } = await import("./reporter");

type Sentry = typeof Sdk;

/** A stand-in SDK that records what it was asked to do. */
const fakeSdk = (): { sdk: Sentry; init: ReturnType<typeof vi.fn>; capture: ReturnType<typeof vi.fn> } => {
  const init = vi.fn();
  const capture = vi.fn();
  const integration = (name: string) => () => ({ name });
  const sdk = {
    init,
    captureException: capture,
    eventFiltersIntegration: integration("EventFilters"),
    functionToStringIntegration: integration("FunctionToString"),
    browserApiErrorsIntegration: integration("BrowserApiErrors"),
    breadcrumbsIntegration: vi.fn(integration("Breadcrumbs")),
    globalHandlersIntegration: integration("GlobalHandlers"),
    linkedErrorsIntegration: integration("LinkedErrors"),
    dedupeIntegration: integration("Dedupe"),
    httpContextIntegration: integration("HttpContext"),
  } as unknown as Sentry;
  return { sdk, init, capture };
};

const options = (dsn: string, load: () => Promise<Sentry>) => ({
  dsn,
  load,
  release: "trackyourtime@1.2.3+abcdef012345",
  environment: "production",
  platform: () => "ios" as const,
  appShell: () => true,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("without a DSN", () => {
  it("never loads the SDK, and reporting does nothing", async () => {
    const load = vi.fn();
    const reporter = createErrorReporter(options("", load));
    reporter.report(new Error("boom"), { source: "app" });
    expect(await reporter.start()).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("is what this build does: the default reporter imports nothing", async () => {
    // Vitest runs with no NEXT_PUBLIC_SENTRY_DSN, exactly like a build without one.
    expect(process.env.NEXT_PUBLIC_SENTRY_DSN ?? "").toBe("");
    reportClientError(new Error("boom"), { source: "global" });
    expect(await startErrorReporting()).toBe(false);
    expect(sdkImported).toBe(false);
  });
});

describe("with a DSN", () => {
  it("loads the SDK once and starts it without tracing, replay, sessions or default integrations", async () => {
    const { sdk, init } = fakeSdk();
    const load = vi.fn(async () => sdk);
    const reporter = createErrorReporter(options("https://key@glitchtip.example.com/2", load));

    expect(await Promise.all([reporter.start(), reporter.start()])).toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);

    const config = init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      dsn: "https://key@glitchtip.example.com/2",
      release: "trackyourtime@1.2.3+abcdef012345",
      environment: "production",
      sendDefaultPii: false,
      sendClientReports: false,
      defaultIntegrations: false,
      initialScope: { tags: { platform: "ios" } },
    });
    expect(config).not.toHaveProperty("tracesSampleRate");
    expect(config).not.toHaveProperty("replaysSessionSampleRate");
    const names = (config.integrations as Array<{ name: string }>).map((i) => i.name);
    expect(names).not.toContain("BrowserSession");
    expect(names).not.toContain("BrowserTracing");
    expect(names).not.toContain("Replay");
    expect(sdk.breadcrumbsIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ console: false, dom: false }),
    );
  });

  it("sends the errors caught before the SDK loaded, with their tags", async () => {
    const { sdk, capture } = fakeSdk();
    let resolve: (value: Sentry) => void = () => undefined;
    const reporter = createErrorReporter(options("https://k@h/1", () => new Promise((r) => (resolve = r))));

    const early = new Error("before mount");
    reporter.report(early, { source: "global" });
    const chunk = new Error("Loading chunk 3 failed.");
    reporter.report(chunk, { source: "app", chunkReload: "refused" });
    expect(capture).not.toHaveBeenCalled();

    resolve(sdk);
    await reporter.start();
    expect(capture).toHaveBeenNthCalledWith(1, early, { tags: { source: "global" } });
    expect(capture).toHaveBeenNthCalledWith(2, chunk, { tags: { source: "app", chunk_reload: "refused" } });

    const later = new Error("after");
    reporter.report(later, { source: "chunk-watch" });
    expect(capture).toHaveBeenLastCalledWith(later, { tags: { source: "chunk-watch" } });
  });

  it("gives up quietly when the SDK chunk cannot load", async () => {
    const reporter = createErrorReporter(
      options("https://k@h/1", () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"))),
    );
    reporter.report(new Error("boom"), { source: "app" });
    expect(await reporter.start()).toBe(false);
  });

  it("scrubs in beforeSend and drops a web chunk error the reload guard is handling", async () => {
    const { sdk, init } = fakeSdk();
    const reporter = createErrorReporter({
      ...options("https://k@h/1", async () => sdk),
      appShell: () => false,
    });
    await reporter.start();
    const { beforeSend } = init.mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, unknown>, hint: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(beforeSend({ user: { email: "a@b.co" }, message: "x" }, {})).toEqual({ message: "x" });
    const chunkError = new Error("Loading chunk 1 failed.");
    expect(beforeSend({ exception: { values: [] } }, { originalException: chunkError })).toBeNull();
  });
});

describe("releaseName", () => {
  it("is the root version plus the short commit", () => {
    expect(releaseName("0.2.0", "0123456789abcdef0123")).toBe("trackyourtime@0.2.0+0123456789ab");
    expect(releaseName("0.2.0", "")).toBe("trackyourtime@0.2.0");
    expect(releaseName("", "abc")).toBeUndefined();
  });
});
