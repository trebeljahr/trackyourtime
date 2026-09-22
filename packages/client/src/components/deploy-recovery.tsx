"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/sonner";
import { translate } from "@/i18n/translate";
import { isAppShell } from "@/lib/shell";
import { reloadOnceForChunkError, watchChunkErrors } from "@/lib/chunk-reload";
import { reportClientError } from "@/lib/error-reporting/reporter";
import { CHUNK_RELOAD_REFUSED } from "@/lib/error-reporting/scrub";
import {
  BUILD_COMMIT,
  createDeployWatcher,
  fetchDeployedCommit,
  reloadWhenIdle,
  shouldWatchForDeploys,
  watchForDeploys,
} from "@/lib/deploy-version";

const UPDATE_TOAST_ID = "deploy-update-available";

/**
 * Keeps a long-open web tab usable across deploys: offers a reload when a
 * newer build is live, and reloads once when a removed chunk fails to load.
 * See `lib/deploy-version.ts` and `lib/chunk-reload.ts`.
 *
 * Renders nothing, and decides everything in an effect — the host is only
 * known after mount, and the prerendered HTML must be the same on every host.
 * Mounted inside the query provider so a reload can wait for writes in flight.
 */
export function DeployRecovery(): null {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    const isProductionBuild = process.env.NODE_ENV === "production";
    const shell = isAppShell();
    if (shell || !isProductionBuild) return;

    // The default handler, plus a report when the guard refuses: a chunk that
    // is still missing after the one reload is a broken deploy, not a stale tab.
    const stopChunkWatch = watchChunkErrors((error) => {
      if (!reloadOnceForChunkError()) {
        reportClientError(error, { source: "chunk-watch", chunkReload: CHUNK_RELOAD_REFUSED });
      }
    });
    if (!shouldWatchForDeploys({ bakedCommit: BUILD_COMMIT, isProductionBuild, isAppShell: shell })) {
      return stopChunkWatch;
    }

    let cancelReload: () => void = () => undefined;
    const mutations = queryClient.getMutationCache();
    const watcher = createDeployWatcher({
      bakedCommit: BUILD_COMMIT,
      fetchCommit: fetchDeployedCommit,
      onNewVersion: () => {
        const t = translate("shell");
        toast(t("update.available"), {
          id: UPDATE_TOAST_ID,
          duration: Infinity,
          action: {
            label: t("update.reload"),
            onClick: () => {
              cancelReload();
              cancelReload = reloadWhenIdle(
                {
                  isMutating: () => queryClient.isMutating(),
                  subscribe: (listener) => mutations.subscribe(listener),
                },
                () => window.location.reload(),
              );
            },
          },
        });
      },
    });
    const stopDeployWatch = watchForDeploys(watcher);

    return () => {
      stopChunkWatch();
      stopDeployWatch();
      cancelReload();
    };
  }, [queryClient]);

  return null;
}
