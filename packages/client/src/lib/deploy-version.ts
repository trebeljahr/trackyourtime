/**
 * Telling an open tab that a newer web build has been deployed.
 *
 * Every deploy replaces the client image, so the hashed chunks the running
 * bundle was built with stop existing. A tab left open across a deploy keeps
 * working until it lazy-loads a route it has not visited yet — then that
 * chunk 404s. This watcher notices the deploy first and offers a reload; the
 * reload itself is always the person's decision (`lib/chunk-reload.ts` is the
 * fallback for the tab that did not take it).
 *
 * **Web only.** The Capacitor, Electron and Tauri shells carry their bundle
 * inside the app, so a deploy of the web image says nothing about them. They
 * also build without `NEXT_PUBLIC_BUILD_COMMIT`, which disables the watcher on
 * its own; `shouldWatchForDeploys` checks the host as well, so a shell built
 * with the variable set by accident still never asks.
 *
 * Nothing here runs during a render: `DeployRecovery` starts it from an effect,
 * so the prerendered HTML is identical on every host.
 */

/** How often, at most, the tab asks the server which build is live. */
export const DEPLOY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The commit the running bundle was built from, or "" for an unstamped build. */
export const BUILD_COMMIT: string = process.env.NEXT_PUBLIC_BUILD_COMMIT ?? "";

export type DeployWatchHost = {
  bakedCommit: string;
  /** `next dev`, or a test run: no image, no `/version.json`. */
  isProductionBuild: boolean;
  /** Capacitor, Electron or Tauri. */
  isAppShell: boolean;
};

export const shouldWatchForDeploys = (host: DeployWatchHost): boolean =>
  host.bakedCommit.trim() !== "" && host.isProductionBuild && !host.isAppShell;

/**
 * The live commit from a `/version.json` body, or null when the answer is not
 * one. An unstamped image writes `"commit": ""`, which says nothing about
 * whether this tab is current.
 */
export const readDeployedCommit = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const commit = (body as { commit?: unknown }).commit;
  if (typeof commit !== "string") return null;
  const trimmed = commit.trim();
  return trimmed === "" ? null : trimmed;
};

/** `/version.json`, bypassing every cache on the way. */
export const fetchDeployedCommit = async (): Promise<string | null> => {
  const response = await fetch("/version.json", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  return readDeployedCommit(await response.json());
};

export type DeployWatcherOptions = {
  bakedCommit: string;
  fetchCommit: () => Promise<string | null>;
  onNewVersion: (commit: string) => void;
  now?: () => number;
  intervalMs?: number;
};

export type DeployWatcher = {
  /** Ask the server, unless it was asked within the interval. */
  check: () => Promise<void>;
};

/**
 * The throttled comparison, free of the DOM so it can be tested directly.
 *
 * The clock starts at creation: the tab has just loaded its bundle, so asking
 * straight away would only confirm it. A failed request (offline, a proxy
 * error page, a server that has no `/version.json`) counts as an ask and is
 * otherwise ignored — it is not evidence of a deploy. Each new commit is
 * announced once; a second deploy while the first notice is still unanswered
 * announces again.
 */
export const createDeployWatcher = (options: DeployWatcherOptions): DeployWatcher => {
  const now = options.now ?? ((): number => Date.now());
  const intervalMs = options.intervalMs ?? DEPLOY_CHECK_INTERVAL_MS;
  let lastCheckedAt = now();
  let inFlight = false;
  let announced: string | null = null;

  return {
    check: async () => {
      if (inFlight || now() - lastCheckedAt < intervalMs) return;
      inFlight = true;
      lastCheckedAt = now();
      try {
        const commit = await options.fetchCommit();
        if (commit === null || commit === options.bakedCommit || commit === announced) return;
        announced = commit;
        options.onNewVersion(commit);
      } catch {
        /* offline or not JSON — try again after the next interval */
      } finally {
        inFlight = false;
      }
    },
  };
};

/**
 * Checks when the person comes back to the tab: window focus, or the page
 * becoming visible again. Those are the moments a stale tab is about to be
 * used, and they cost nothing while it sits in the background.
 */
export const watchForDeploys = (watcher: DeployWatcher): (() => void) => {
  const onFocus = (): void => {
    void watcher.check();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") void watcher.check();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
};

export type MutationActivity = {
  isMutating: () => number;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Reload once no write is in flight, or after `timeoutMs` regardless.
 *
 * What a reload would lose is small but real: the offline queue, the running
 * timer mirror and every preference are already in storage, but a request in
 * flight is aborted, and `lib/offline.ts` deliberately does not queue a write
 * that fails while the document unloads. Waiting for the answer keeps that
 * edge from mattering. The click that asked for the reload also blurs a field
 * that commits on blur, which starts exactly such a write.
 */
export const reloadWhenIdle = (
  activity: MutationActivity,
  reload: () => void,
  timeoutMs = 10_000,
): (() => void) => {
  if (activity.isMutating() === 0) {
    reload();
    return () => undefined;
  }

  let done = false;
  const stop = (): void => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const finish = (): void => {
    if (done) return;
    stop();
    reload();
  };
  const unsubscribe = activity.subscribe(() => {
    if (activity.isMutating() === 0) finish();
  });
  const timer = setTimeout(finish, timeoutMs);
  return stop;
};
