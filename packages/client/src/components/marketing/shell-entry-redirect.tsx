"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { isTokenShell } from "@/lib/shell";

/**
 * Sends the native and desktop shells from `/` into the app.
 *
 * Capacitor and Electron both load the export's `index.html`, which is
 * the landing page — an advertisement for the app the person is already
 * holding. So inside a shell `/` moves straight on to /app/track, without
 * waiting for a session: the protected layout decides sign-in, and it must be
 * allowed to decide it with no network.
 *
 * On the web this does nothing, signed in or not. The public pages are
 * pages a signed-in person visits on purpose; the header's "Open the app"
 * link is how they get back.
 */
export function ShellEntryRedirect(): null {
  const router = useRouter();

  useEffect(() => {
    if (isTokenShell()) router.replace("/app/track");
  }, [router]);

  return null;
}
