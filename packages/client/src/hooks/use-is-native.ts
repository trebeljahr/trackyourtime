"use client";

import * as React from "react";

import { isNative } from "@/mobile/bridge";

const subscribe = (): (() => void) => () => undefined;
const serverSnapshot = (): boolean => false;

/**
 * `isNative()`, safe to branch a render on.
 *
 * Every page is prerendered in Node, where `window.Capacitor` cannot exist, so
 * a component that rendered something different on native during its FIRST
 * render would hand React a tree that disagrees with the served HTML — which
 * React resolves by throwing the served DOM away. `useSyncExternalStore` with
 * a `false` server snapshot hydrates as the web tree and re-renders once with
 * the real answer, so the prerendered markup and hydration always agree and a
 * web page's tree is exactly what it was.
 */
export const useIsNative = (): boolean =>
  React.useSyncExternalStore(subscribe, isNative, serverSnapshot);
