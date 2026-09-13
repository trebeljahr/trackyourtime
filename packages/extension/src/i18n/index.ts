/**
 * The browser extension's translated text.
 *
 * NOT `chrome.i18n`, deliberately. `chrome.i18n.getMessage` answers in the
 * browser's UI language, fixed at install, while Track Your Time's language is
 * a synced account preference: somebody who chose Deutsch in the web app on an
 * English Chrome would get an English popup beside a German web app, and
 * nothing in the popup could change it. `chrome.i18n` is used only where
 * Chrome itself renders text — the extension name and description in
 * `public/_locales`, referenced from the manifest as `__MSG_*__`.
 *
 * The popup instead resolves the same preference the web app does
 * (`settings.locale`, "system" → `navigator.languages`) with the same shared
 * resolver, keeps a synchronous `localStorage` copy so the first render is
 * already in the right language (the popup is rebuilt on every open, exactly
 * like the theme — see popup/theme.ts), and formats with `use-intl/core`, so
 * ICU syntax and `Translation<>` typing match the web client's catalogs.
 */
import { createTranslator, type _Translator } from "use-intl/core";
import {
  isLocalePreference,
  resolveLocalePreference,
  type Locale,
  type LocalePreference,
} from "@starter/shared";

import { background as deBackground } from "./messages/de/background";
import { popup as dePopup } from "./messages/de/popup";
import { background as enBackground } from "./messages/en/background";
import { popup as enPopup } from "./messages/en/popup";

const en = { popup: enPopup, background: enBackground } as const;
const de = { popup: dePopup, background: deBackground };

export type ExtensionMessages = typeof en;
export type ExtensionNamespace = keyof ExtensionMessages;
export type ExtensionTranslator<N extends ExtensionNamespace> = _Translator<ExtensionMessages, N>;

export const extensionMessages = { en, de } as const;

const STORAGE_KEY = "tracktime.locale";

const languages = (): readonly string[] =>
  typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];

/**
 * The last preference this popup was told about ("system" until told one),
 * read synchronously. `localStorage` is unavailable in the service worker,
 * which falls back to "system" and receives the real preference with the
 * settings snapshot.
 */
export const cachedLocalePreference = (): LocalePreference => {
  try {
    const stored: unknown = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocalePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
};

/** Remember the account's preference for the next open. Returns the resolved locale. */
export const rememberLocalePreference = (preference: LocalePreference): Locale => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, preference);
  } catch {
    /* re-learnt from the next snapshot */
  }
  const locale = resolveLocalePreference(preference, languages());
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  return locale;
};

/** The locale a preference resolves to on this browser. */
export const resolveExtensionLocale = (
  preference: LocalePreference = cachedLocalePreference(),
): Locale => resolveLocalePreference(preference, languages());

const cache = new Map<string, unknown>();

/**
 * A translator for one namespace in one locale:
 *
 * ```ts
 * const t = extensionT(locale, "popup");
 * t("timer.start");
 * ```
 *
 * In a component, derive `locale` from the snapshot's `settings.locale` via
 * `resolveExtensionLocale`, falling back to `cachedLocalePreference()` until
 * the first snapshot, and remember it with `rememberLocalePreference` — the
 * same shape App.tsx already uses for the theme.
 */
export const extensionT = <N extends ExtensionNamespace>(
  locale: Locale,
  namespace: N,
): ExtensionTranslator<N> => {
  const key = `${locale}:${namespace}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as ExtensionTranslator<N>;
  const translator = createTranslator({
    locale,
    messages: extensionMessages[locale] as unknown as ExtensionMessages,
    namespace,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onError: () => undefined,
    getMessageFallback: ({ namespace: ns, key: messageKey }) =>
      ns ? `${ns}.${messageKey}` : messageKey,
  }) as unknown as ExtensionTranslator<N>;
  cache.set(key, translator);
  return translator;
};
