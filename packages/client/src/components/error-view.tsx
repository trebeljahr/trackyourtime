"use client";

import * as React from "react";

import { useT } from "@/i18n/use-t";
import { isAppShell } from "@/lib/shell";
import { isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunk-reload";
import { reportClientError } from "@/lib/error-reporting/reporter";
import { CHUNK_RELOAD_REFUSED } from "@/lib/error-reporting/scrub";

/**
 * The body of app/global-error.tsx and app/app/error.tsx.
 *
 * A chunk that no longer exists (the tab outlived a deploy) is reloaded once
 * automatically on the web; if that already happened, or on any other error,
 * the screen offers the reload itself. The shells skip the automatic reload —
 * their chunks ship inside the app, so a reload fetches the same files.
 *
 * Every error it shows is reported (a no-op in a build without a DSN), except
 * a web chunk error the automatic reload is about to fix: only one the guard
 * refused to reload again is sent, tagged so `lib/error-reporting/scrub.ts`
 * keeps it. The reload decision is made first and is never delayed by the
 * report, which is queued and sent in the background.
 */
export function ErrorView({
  error,
  reset,
  boundary,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Which boundary rendered this, for the report's `source` tag. */
  boundary: "app" | "global";
}): React.JSX.Element {
  const t = useT("shell");
  const chunk = isChunkLoadError(error);

  React.useEffect(() => {
    if (chunk && !isAppShell()) {
      if (reloadOnceForChunkError()) return;
      reportClientError(error, { source: boundary, chunkReload: CHUNK_RELOAD_REFUSED });
      return;
    }
    reportClientError(error, { source: boundary });
  }, [chunk, error, boundary]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6" data-testid="error-view" role="alert">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">{t("errorPage.title")}</h1>
          <p className="leading-relaxed text-muted-foreground">
            {chunk ? t("errorPage.chunkBody") : t("errorPage.body")}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            data-testid="error-view-reload"
            onClick={() => window.location.reload()}
            className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("errorPage.reload")}
          </button>
          {chunk ? null : (
            <button
              type="button"
              data-testid="error-view-retry"
              onClick={reset}
              className="inline-flex h-10 items-center rounded-md border px-5 text-sm font-medium hover:bg-accent"
            >
              {t("errorPage.retry")}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
