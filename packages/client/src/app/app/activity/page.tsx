"use client";

import * as React from "react";

import { SuggestionsScreen } from "@/components/activity/suggestions-screen";

/**
 * `/app/activity` — the desktop app's activity suggestions. Prerendered as the
 * web's notice; the desktop screen appears after hydration.
 */
export default function ActivityPage(): React.JSX.Element {
  return <SuggestionsScreen />;
}
