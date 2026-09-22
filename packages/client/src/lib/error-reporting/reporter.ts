import { APP_VERSION } from "@/lib/app-version";
import { BUILD_COMMIT } from "@/lib/deploy-version";
import { isAppShell, isCapacitor, isElectron } from "@/lib/shell";
import { CHUNK_RELOAD_REFUSED, scrubBreadcrumb, scrubEvent, shouldDropEvent } from "./scrub";
import type * as Sdk from "./sdk";

/**
 * Error reports from the web app, the desktop app and the phone apps, to a
 * Sentry-protocol endpoint (GlitchTip), the same kind the API server reports to
 * with `SENTRY_DSN`.
 *
 * Opt-in per build: `NEXT_PUBLIC_SENTRY_DSN` is inlined at build time, and a
 * build without it never loads the SDK. The SDK is a dynamic import started
 * after mount, so it is never part of the prerendered HTML or the first
 * chunks, and nothing here runs while rendering — the host is known only in
 * an effect, and every host is served the same HTML.
 *
 * What a report may contain is `scrub.ts`. What it adds is only this build's
 * release and the platform. No session replay, no performance tracing (which
 * would also add `sentry-trace`/`baggage` headers to every API request, and a
 * header the API does not allow fails the CORS preflight), and no session
 * pings: the SDK sends something only when an error happens.
 */

/** The SDK surface the reporter uses: the named re-exports in `sdk.ts`. */
type Sentry = typeof Sdk;

/** The host a report came from. The `platform` tag on every event. */
export type ReportingPlatform = "web" | "electron" | "ios" | "android";

/** Where a report was captured by this code, rather than by the SDK's global handlers. */
export interface ReportContext {
  /** `app` is app/app/error.tsx, `global` is app/global-error.tsx, `chunk-watch` is DeployRecovery's listener. */
  source: "app" | "global" | "chunk-watch";
  /** Set when the reload-once guard in lib/chunk-reload.ts refused to reload for this error. */
  chunkReload?: typeof CHUNK_RELOAD_REFUSED;
}

export interface ErrorReporter {
  /** Loads and starts the SDK once. Resolves false when there is no DSN or the SDK failed to load. */
  start(): Promise<boolean>;
  /** Reports an error caught by an error boundary or a listener. A no-op without a DSN. */
  report(error: unknown, context: ReportContext): void;
}

export interface ErrorReporterOptions {
  dsn: string;
  /** Imports the SDK. Never called when `dsn` is empty. */
  load: () => Promise<Sentry>;
  release: string | undefined;
  environment: string;
  /** Read when the SDK starts, which is always after mount. */
  platform: () => ReportingPlatform;
  appShell: () => boolean;
}

/** Errors held while the SDK loads. An error before mount is the likeliest to matter. */
const MAX_PENDING = 20;

/**
 * `trackyourtime@<version>+<commit>`, the release every event is tagged with.
 * The commit is what tells two builds of one version apart (a web deploy
 * between tags, or a desktop build from a branch). Undefined without a version,
 * which only a unit test or a broken build has.
 */
export function releaseName(version: string, commit: string): string | undefined {
  if (!version) return undefined;
  const build = commit.trim().slice(0, 12);
  return build ? `trackyourtime@${version}+${build}` : `trackyourtime@${version}`;
}

type CapacitorPlatformGlobal = { getPlatform?: () => string };

/** This host, read from the globals the shells inject. Call after mount only. */
export function reportingPlatform(): ReportingPlatform {
  if (isElectron()) return "electron";
  if (isCapacitor()) {
    const cap = (window as unknown as { Capacitor?: CapacitorPlatformGlobal }).Capacitor;
    return cap?.getPlatform?.() === "ios" ? "ios" : "android";
  }
  return "web";
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  let started: Promise<boolean> | null = null;
  let sdk: Sentry | null = null;
  let pending: Array<{ error: unknown; context: ReportContext }> = [];

  const capture = (client: Sentry, error: unknown, context: ReportContext): void => {
    client.captureException(error, {
      tags: {
        source: context.source,
        ...(context.chunkReload ? { chunk_reload: context.chunkReload } : {}),
      },
    });
  };

  const start = (): Promise<boolean> => {
    if (!options.dsn) return Promise.resolve(false);
    started ??= options
      .load()
      .then((client) => {
        client.init({
          dsn: options.dsn,
          release: options.release,
          environment: options.environment,
          sendDefaultPii: false,
          sendClientReports: false,
          // No tracing: no tracesSampleRate and no browserTracingIntegration.
          // The list replaces the SDK defaults, leaving out the session
          // integration (a ping on every page load), the culture context and
          // the DOM and console breadcrumbs.
          defaultIntegrations: false,
          integrations: [
            client.eventFiltersIntegration(),
            client.functionToStringIntegration(),
            client.browserApiErrorsIntegration(),
            client.breadcrumbsIntegration({ console: false, dom: false, sentry: false, fetch: true, xhr: true, history: true }),
            client.globalHandlersIntegration(),
            client.linkedErrorsIntegration(),
            client.dedupeIntegration(),
            client.httpContextIntegration(),
          ],
          maxBreadcrumbs: 30,
          beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
          beforeSend: (event, hint) =>
            shouldDropEvent(event, hint, { appShell: options.appShell() }) ? null : scrubEvent(event),
          initialScope: { tags: { platform: options.platform() } },
        });
        sdk = client;
        const held = pending;
        pending = [];
        for (const { error, context } of held) capture(client, error, context);
        return true;
      })
      .catch(() => {
        // The SDK chunk itself failed to load (offline, or a deploy removed
        // it). Caught here so it never reaches DeployRecovery's
        // unhandledrejection listener as a chunk error of the app's own.
        pending = [];
        return false;
      });
    return started;
  };

  return {
    start,
    report(error, context) {
      if (!options.dsn) return;
      if (sdk) {
        capture(sdk, error, context);
        return;
      }
      if (pending.length < MAX_PENDING) pending.push({ error, context });
      void start();
    },
  };
}

/**
 * The SDK import, behind a condition on the inlined DSN in the same
 * expression. `next.config.ts` defines `NEXT_PUBLIC_SENTRY_DSN` as "" when it
 * is unset, so the condition is a literal in every build; with no DSN the
 * bundler folds it to its false branch, and the import — and with it the SDK
 * chunk — drops out of the export. `createErrorReporter` never calls it then
 * anyway. The import names `./sdk`, not the package, so the chunk that is
 * built with a DSN holds only what the reporter uses.
 */
const loadSentry = (): Promise<Sentry> =>
  process.env.NEXT_PUBLIC_SENTRY_DSN
    ? import("./sdk")
    : Promise.reject(new Error("error reporting is not configured"));

const reporter = createErrorReporter({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "",
  load: loadSentry,
  release: releaseName(APP_VERSION, BUILD_COMMIT),
  environment: process.env.NODE_ENV ?? "development",
  platform: reportingPlatform,
  appShell: isAppShell,
});

/** Starts reporting if this build has a DSN. Call from an effect. */
export const startErrorReporting = (): Promise<boolean> => reporter.start();

/** Reports an error an error boundary or listener caught. A no-op in a build without a DSN. */
export const reportClientError = (error: unknown, context: ReportContext): void => reporter.report(error, context);
