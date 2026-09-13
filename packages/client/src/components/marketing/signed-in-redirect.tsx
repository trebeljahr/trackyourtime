"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/providers/auth-provider";
import { isNative } from "@/mobile/bridge";

/**
 * Sends a signed-in visitor from `/` to `/track`, which was the only thing `/`
 * did before it had a landing page.
 *
 * The page underneath renders first and this runs after, not the other way
 * round: a signed-out visitor sees the page at once instead of a "Loading…"
 * stub, and a signed-in one lands on /track once the session resolves, as they
 * always did. The native shell does not wait for a session at all — its
 * protected layout decides sign-in, and it must be allowed to decide it with no
 * network.
 */
export function SignedInRedirect(): null {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isNative()) {
      router.replace("/track");
      return;
    }
    if (!isLoading && isAuthenticated) router.replace("/track");
  }, [isAuthenticated, isLoading, router]);

  return null;
}
