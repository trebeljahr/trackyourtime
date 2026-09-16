/**
 * Recovering a web tab whose code chunks were removed by a deploy.
 *
 * Hashed chunks are cached forever and replaced on every deploy, so a tab
 * opened before one asks for names the server no longer has the first time it
 * lazy-loads a route. The fix is a reload, which fetches the current HTML and
 * the current chunk names. It is done automatically only ONCE per short
 * window: when the reload does not help (the server really is broken, or the
 * device is offline), a second automatic reload would loop forever, and the
 * error screen with its own Reload button is the right place to stop.
 *
 * Web only, like `lib/deploy-version.ts`: the shells load their chunks from
 * inside the app, where a reload fetches the very same files again.
 */

export const CHUNK_RELOAD_STORAGE_KEY = "trackyourtime:chunk-reload-at";

/** An automatic reload within this long of the previous one is refused. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

const CHUNK_ERROR_MESSAGES: readonly RegExp[] = [
  /Loading (CSS )?chunk [\w/.-]+ failed/i,
  /Failed to load chunk/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
];

/** Whether a thrown value is a failed chunk or dynamic import load. */
export const isChunkLoadError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return typeof error === "string" && CHUNK_ERROR_MESSAGES.some((re) => re.test(error));
  }
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string" && CHUNK_ERROR_MESSAGES.some((re) => re.test(message));
};

export type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

const sessionStore = (): ReloadStorage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Reload, unless this tab already did so for a chunk error within the window.
 * Returns whether it reloaded.
 *
 * Without working storage there is no way to know whether this is the second
 * attempt, so it does not reload at all and leaves it to the error screen.
 */
export const reloadOnceForChunkError = (
  reload: () => void = () => window.location.reload(),
  storage: ReloadStorage | null = sessionStore(),
  now: number = Date.now(),
): boolean => {
  if (storage === null) return false;
  try {
    const previous = Number(storage.getItem(CHUNK_RELOAD_STORAGE_KEY));
    if (Number.isFinite(previous) && previous > 0 && now - previous < CHUNK_RELOAD_WINDOW_MS) {
      return false;
    }
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
};

/**
 * Listens for chunk failures nothing else caught: a rejected `import()` and an
 * error thrown outside React. Errors React catches reach `error.tsx` /
 * `global-error.tsx`, which call `reloadOnceForChunkError` themselves.
 */
export const watchChunkErrors = (
  onChunkError: () => void = () => {
    reloadOnceForChunkError();
  },
): (() => void) => {
  const onError = (event: ErrorEvent): void => {
    if (isChunkLoadError(event.error ?? event.message)) onChunkError();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (isChunkLoadError(event.reason)) onChunkError();
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
};
