"use client";

import * as React from "react";

import {
  getApiOriginSnapshot,
  getServerApiOriginSnapshot,
  hydrateApiOrigin,
  subscribeApiOrigin,
  type ApiOriginSnapshot,
} from "@/lib/api-origin";

/**
 * The server this device is pointed at, as React state.
 *
 * The same contract as `useNativeSession`: hydration is started on mount and
 * never changes what renders while it is in flight — the prerender and the
 * first client render both see the build default, so the served HTML and the
 * hydrated tree cannot disagree. On web the choice is always null.
 */
export const useApiOrigin = (): ApiOriginSnapshot => {
  const snapshot = React.useSyncExternalStore(
    subscribeApiOrigin,
    getApiOriginSnapshot,
    getServerApiOriginSnapshot,
  );

  React.useEffect(() => {
    void hydrateApiOrigin();
  }, []);

  return snapshot;
};
