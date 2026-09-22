/*
 * The headless source: answers only what a test told it, only when a test
 * asks (`tick`). No child process, no timer, and never the real frontmost
 * application of whoever is using the machine.
 */

import type { FrontmostTarget } from "./keys.ts";
import type { FrontmostSource, SourceListener } from "./source.ts";

export interface FakeFrontmostSource extends FrontmostSource {
  setFrontmost: (target: FrontmostTarget | null) => void;
  /** Deliver the current answer, as one poll would. False when the source is not running. */
  emit: () => boolean;
  running: () => boolean;
  titles: () => boolean;
}

export function createFakeFrontmostSource(): FakeFrontmostSource {
  let listener: SourceListener | null = null;
  let current: FrontmostTarget | null = null;
  let titles = false;
  return {
    kind: "fake",
    start: (next) => {
      listener = next;
    },
    stop: () => {
      listener = null;
    },
    setTitles: (on) => {
      titles = on;
    },
    setFrontmost: (target) => {
      current = target === null ? null : { ...target };
    },
    emit: () => {
      if (listener === null) return false;
      const target = current === null ? null : { ...current };
      // A real source reads a title only while titles are on.
      if (target !== null && !titles) delete target.title;
      listener.target(target);
      return true;
    },
    running: () => listener !== null,
    titles: () => titles,
  };
}
