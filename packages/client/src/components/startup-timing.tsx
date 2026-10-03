"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/providers/auth-provider";
import { markAuthenticationReady, resetStartupTiming } from "@/lib/startup-timing";

/** Observe existing auth state; never fetch or change routing. */
export function StartupTiming(): null {
  const { user, isAuthenticated, isLoading } = useAuth();
  const authenticated = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) markAuthenticationReady();
    else if (authenticated.current) resetStartupTiming();
    authenticated.current = isAuthenticated;
  }, [user, isAuthenticated, isLoading]);
  return null;
}
