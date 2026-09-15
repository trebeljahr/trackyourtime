"use client";

import * as React from "react";

import { DeviceApproval } from "@/components/device/device-approval";

/**
 * The browser half of the device-authorization flow.
 *
 * Raycast, a CLI or a TV-style client shows a short code; the user types it
 * here — already signed in, in a real browser — and the waiting client
 * receives a session of its own. It sits under `/app/` so an anonymous
 * visitor is sent to sign in first, which is exactly the right order.
 *
 * The code may arrive prefilled via `?user_code=`, so `useSearchParams` needs
 * a Suspense boundary for the static export.
 */
export default function DevicePage() {
  return (
    <React.Suspense fallback={null}>
      <DeviceApproval />
    </React.Suspense>
  );
}
