"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * `/app/` itself has no screen of its own; it is the tracker's address
 * without the last segment, so it forwards there. Client-side, because the
 * static export has no redirects, and `replace` so back skips it.
 */
export default function AppIndexPage(): null {
  const router = useRouter();
  React.useEffect(() => {
    router.replace("/app/track");
  }, [router]);
  return null;
}
