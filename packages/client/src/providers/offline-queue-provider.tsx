"use client";

import * as React from "react";

import {
  useOfflineQueue,
  type OfflineQueueState,
} from "@/hooks/use-offline-queue";

/**
 * One offline queue for the whole signed-in app.
 *
 * `useOfflineQueue()` used to be called from `TrackerBar`, which renders only
 * on `/app/track`. Everything that drains the queue — the socket reopening, the
 * network coming back — is wired up inside that hook, so a user who
 * reconnected while looking at Reports or Settings had nothing listening:
 * their queued entries sat there until they happened to navigate to the
 * tracker. That is a plain web bug, not a mobile one; it is simply guaranteed
 * on a phone, where the app is backgrounded and resumed on whatever screen it
 * was left on.
 *
 * Mounting it in `AppShell` fixes it for every route at once. The context
 * exists so `TrackerBar` and the resume handler read the same instance rather
 * than each starting their own flush loop.
 */
const OfflineQueueContext = React.createContext<OfflineQueueState | null>(null);

export function OfflineQueueProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const state = useOfflineQueue();
  return (
    <OfflineQueueContext.Provider value={state}>
      {children}
    </OfflineQueueContext.Provider>
  );
}

/**
 * The shell's queue state. Throws outside the provider on purpose: a silent
 * fallback would mean a second queue instance with its own flush loop, which
 * is the failure this provider exists to prevent.
 */
export function useOfflineQueueState(): OfflineQueueState {
  const state = React.useContext(OfflineQueueContext);
  if (state === null) {
    throw new Error(
      "useOfflineQueueState() must be used inside <OfflineQueueProvider>, " +
        "which AppShell mounts for every signed-in route.",
    );
  }
  return state;
}
