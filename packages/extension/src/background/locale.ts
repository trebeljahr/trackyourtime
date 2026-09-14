/**
 * The service worker's language, for the little text it renders itself — the
 * toolbar badge.
 *
 * The popup has a synchronous `localStorage` mirror; the worker has no
 * `localStorage` at all, and MV3 evicts it about every thirty seconds, taking
 * its settings cache with it. An alarm that wakes a fresh worker would then
 * paint the badge in the browser's language until the next snapshot, and the
 * badge would visibly flip between two spellings. So the account's preference
 * is copied into `chrome.storage.local` whenever settings arrive, and a cold
 * worker reads it back before it renders anything.
 *
 * Error messages are deliberately not translated here — see
 * `popup/errors.ts`, which says them from the code in the popup's language.
 */
import { isLocalePreference, type LocalePreference } from "@starter/shared";
import { chromeStorage, localStorageArea } from "../lib/chrome-storage";
import {
  extensionT,
  resolveExtensionLocale,
  type ExtensionTranslator,
} from "../i18n";

const LOCALE_STORAGE_KEY = "trackyourtime.locale";

/** The preference this worker instance knows, or null until it has looked. */
let known: LocalePreference | null = null;

/**
 * Record the account's preference from a settings read or write. Written to
 * storage only when it changed, so the three-second poll costs nothing.
 */
export const noteLocalePreference = (preference: LocalePreference): void => {
  if (known === preference) return;
  known = preference;
  void chromeStorage(localStorageArea()).setItem(LOCALE_STORAGE_KEY, preference);
};

/** A translator for the worker's own text, in the account's language. */
export const backgroundT = async (): Promise<ExtensionTranslator<"background">> => {
  if (known === null) {
    const stored = await chromeStorage(localStorageArea()).getItem(LOCALE_STORAGE_KEY);
    // A later `noteLocalePreference` during the await wins over the disk copy.
    if (known === null && isLocalePreference(stored)) known = stored;
  }
  return extensionT(resolveExtensionLocale(known ?? "system"), "background");
};
