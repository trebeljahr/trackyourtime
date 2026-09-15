"use client";

import * as React from "react";

import { EntryList } from "@/components/tracker/entry-list";
import { TrackerBar } from "@/components/tracker/tracker-bar";

/**
 * The screen trackyourtime is used through every day: the tracker bar pinned under
 * the app header, and the day-grouped log of everything tracked below it.
 */
export default function TrackPage(): React.JSX.Element {
  return (
    <div data-testid="track-page">
      <TrackerBar />
      <EntryList />
    </div>
  );
}
