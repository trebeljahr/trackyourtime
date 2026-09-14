/**
 * The popup's active language, as a tiny external store, and the hooks that
 * read it.
 *
 * No provider, the same as the web client: the popup is a single client-only
 * tree with no prerendered HTML to match, so the locale can be resolved
 * synchronously before the first render (from the `localStorage` mirror in
 * ./index.ts) and corrected the moment a snapshot carries the account's real
 * preference. `App` calls {@link applyLocalePreference} for that, exactly as it
 * calls `rememberTheme`.
 */
import { useSyncExternalStore } from "react";
import type { Locale, LocalePreference } from "@starter/shared";

import {
  extensionT,
  rememberLocalePreference,
  resolveExtensionLocale,
  type ExtensionNamespace,
  type ExtensionTranslator,
} from "./index";

let current: Locale = resolveExtensionLocale();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = (): Locale => current;

/**
 * Adopt the account's preference: remembered for the next open, written onto
 * `<html lang>`, and re-rendered now if it changes the language.
 */
export const applyLocalePreference = (preference: LocalePreference): void => {
  const next = rememberLocalePreference(preference);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
};

/** The language the popup renders in. */
export const usePopupLocale = (): Locale => useSyncExternalStore(subscribe, snapshot, snapshot);

/**
 * A translator for one namespace in the popup's language:
 *
 * ```tsx
 * const t = useT("popup");
 * t("header.back");
 * t("sync.queuedTitle", { count });
 * ```
 */
export const useT = <N extends ExtensionNamespace>(namespace: N): ExtensionTranslator<N> =>
  extensionT(usePopupLocale(), namespace);

/** The popup's translator type, for plain functions that are handed one. */
export type PopupT = ExtensionTranslator<"popup">;
