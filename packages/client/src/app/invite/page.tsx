"use client";

import * as React from "react";

import { InviteAcceptance } from "@/components/invite/invite-acceptance";

/**
 * `/invite/?id=<id>` — where an invitation email (or a copied link) lands.
 *
 * Public, NOT under `(protected)`: somebody without an account must be able
 * to see whose workspace it is, and the protected layout would redirect them
 * to /login first. And a query parameter, never an `/invite/[id]` segment:
 * the static export can only serve paths that existed at build time.
 * `useSearchParams` needs the Suspense boundary under `output: "export"`.
 */
export default function InvitePage(): React.JSX.Element {
  return (
    <React.Suspense fallback={null}>
      <InviteAcceptance />
    </React.Suspense>
  );
}
