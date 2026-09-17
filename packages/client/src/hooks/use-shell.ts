"use client";

import * as React from "react";

import { isElectron, isTokenShell } from "@/lib/shell";

const subscribe = (): (() => void) => () => undefined;
const serverSnapshot = (): boolean => false;

/*
 * The predicates of `lib/shell.ts`, safe to branch a render on.
 *
 * Every page is prerendered in Node, where neither `window.Capacitor` nor
 * `window.electronAPI` can exist, so a component that rendered something
 * different in a shell during its FIRST render would hand React a tree that
 * disagrees with the served HTML — which React resolves by throwing the served
 * DOM away. `useSyncExternalStore` with a `false` server snapshot hydrates as
 * the web tree and re-renders once with the real answer, so the prerendered
 * markup and hydration always agree and a web page's tree is exactly what it
 * was.
 */

/** `isTokenShell()` after hydration: the phone apps and the desktop app. */
export const useIsTokenShell = (): boolean =>
  React.useSyncExternalStore(subscribe, isTokenShell, serverSnapshot);

/** `isElectron()` after hydration. */
export const useIsElectron = (): boolean =>
  React.useSyncExternalStore(subscribe, isElectron, serverSnapshot);
