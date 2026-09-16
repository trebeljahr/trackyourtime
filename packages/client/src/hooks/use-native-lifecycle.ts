"use client";

import * as React from "react";

import { refreshPendingCount } from "@/lib/offline";
import { refreshServerLevel } from "@/lib/server-level";
import {
  isRunningProvisional,
  writeRunningMirror,
} from "@/lib/running-mirror";
import { reconnectSync, timerStore } from "@/hooks/use-sync";
import { trpc } from "@/lib/trpc";
import { setMobileHandlers } from "@/mobile/bridge";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";

/**
 * Decide what a resume has to do, given how much is queued.
 *
 * Pure, so the ordering — which is the whole content of this hook — is
 * testable without a Capacitor bridge, a socket or a React tree.
 */
export const resumePlan = (pending: number): "flush" | "invalidate" =>
  pending > 0 ? "flush" : "invalidate";

export type ResumeSteps = {
  reconnect: () => void;
  tick: () => void;
  /**
   * Ask the server for its API level again. Started after the tick, in
   * parallel with the pending count, and awaited only before a flush — whose
   * held rows depend on it. An invalidate never waits for it.
   */
  refreshLevel: () => Promise<unknown>;
  pending: () => Promise<number>;
  flush: () => Promise<void>;
  invalidateCurrent: () => Promise<void>;
};

/**
 * What happens when the app comes back to the foreground, in the order it has
 * to happen in.
 *
 * 1. **Reconnect.** The server pings every 10s and drops the socket on the
 *    first missed pong, so the connection is dead server-side within ~20s of
 *    every backgrounding — but a frozen socket delivers no close event, so
 *    the client still believes it is open and never retries.
 * 2. **Tick.** Synchronous and instant, so the clock is right on the FIRST
 *    frame rather than up to a second later. Elapsed is derived from
 *    `entry.start`, so this is just "recompute now".
 * 3. **Refresh the server's API level**, without holding up anything but a
 *    flush: a server updated while the app was in the background releases
 *    the rows held `server-too-old` on this very flush.
 * 4. **Flush, and only then invalidate.** This order is load-bearing and the
 *    obvious one is wrong. A timer started with no signal lives in the queue
 *    and in an optimistic `entries.current`; refetching first asks a server
 *    that has never heard of that start, gets `null`, and blanks the running
 *    clock — the timer visibly vanishes and comes back seconds later, on
 *    exactly the recovery path this exists to smooth. The flush already
 *    invalidates entries and reports when it applies anything, so when there
 *    is something queued the explicit invalidate is not merely reordered, it
 *    is not run at all.
 */
export const runResume = async (steps: ResumeSteps): Promise<void> => {
  steps.reconnect();
  steps.tick();
  const level = steps.refreshLevel().catch(() => undefined);

  if (resumePlan(await steps.pending()) === "flush") {
    await level;
    await steps.flush();
    return;
  }
  await steps.invalidateCurrent();
};

/**
 * Wire the resume sequence to the OS.
 *
 * Mounted once, in `AppShell`. Handlers go in through `setMobileHandlers`
 * rather than `initMobile`, which latched on its first call at the app root
 * long before this shell existed — see `mobile/bridge.ts`.
 */
export const useNativeLifecycle = (): void => {
  const utils = trpc.useUtils();
  const { flush } = useOfflineQueueState();

  const utilsRef = React.useRef(utils);
  const flushRef = React.useRef(flush);
  React.useEffect(() => {
    utilsRef.current = utils;
    flushRef.current = flush;
  }, [utils, flush]);

  React.useEffect(
    () =>
      setMobileHandlers({
        onResume: () => {
          void runResume({
            reconnect: reconnectSync,
            tick: () => timerStore.getState().tick(),
            refreshLevel: refreshServerLevel,
            pending: refreshPendingCount,
            flush: () => flushRef.current(),
            invalidateCurrent: () => utilsRef.current.entries.current.invalidate(),
          });
        },
        onPause: () => {
          // Cheap insurance against the OS killing a backgrounded app: the
          // mirror is otherwise only written when a query resolves, which may
          // have been a while ago. Skipped while the entry on screen IS the
          // mirror's — rewriting it would change nothing except to claim the
          // server has confirmed it.
          if (isRunningProvisional()) return;
          void writeRunningMirror(timerStore.getState().running);
        },
      }),
    [],
  );
};
