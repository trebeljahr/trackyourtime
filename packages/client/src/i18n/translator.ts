/**
 * Message lookup and ICU formatting, with no React and no browser state.
 *
 * Server-safe on purpose: the public pages are server components rendered at
 * build time, once per language, and they call {@link getTranslator} directly.
 * Client components go through `useT` (i18n/use-t.ts), which is this plus the
 * active locale.
 */
import { createTranslator, type _Translator } from "use-intl/core";
import { mapMessages, pseudoLocalize, type Locale } from "@starter/shared";

import type { ClientLocale } from "@/i18n/config";
import { de, en, type Messages, type Namespace } from "@/i18n/messages";

export type { Messages, Namespace };

/**
 * A translator for one namespace: `t("key", values)`, `t.rich(...)`,
 * `t.markup(...)`, `t.has(...)`. Keys and ICU arguments are type-checked
 * against the English catalog.
 */
export type Translator<N extends Namespace> = _Translator<Messages, N>;

let pseudoMessages: Messages | null = null;

/** English with every message pseudo-localised, built on first use. */
const getPseudoMessages = (): Messages => {
  pseudoMessages ??= mapMessages(en, pseudoLocalize);
  return pseudoMessages;
};

/**
 * The catalog for a locale. German is cast to the English type because the two
 * differ only in their literal string types — `Translation<Messages>` already
 * guarantees the keys match.
 */
export const getMessages = (locale: ClientLocale): Messages => {
  if (locale === "de") return de as unknown as Messages;
  if (locale === "pseudo") return getPseudoMessages();
  return en;
};

/** The locale `Intl` and ICU plural rules should use for a client locale. */
export const icuLocale = (locale: ClientLocale): Locale => (locale === "pseudo" ? "en" : locale);

/**
 * The time zone ICU `{d, date}` arguments render in.
 *
 * In a browser, the device's own. During a build, UTC — which is why a
 * prerendered page must never put a date into a message argument: the build
 * machine's zone would be baked into the HTML and disagree with hydration.
 * Format dates with i18n/format.ts and pass the resulting string instead.
 */
const timeZone = (): string => {
  if (typeof window === "undefined") return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

const cache = new Map<string, unknown>();

const isDev = process.env.NODE_ENV !== "production";

/**
 * A translator for `namespace` in `locale`, memoised — building one parses no
 * messages up front, but callers render often.
 *
 * A missing message cannot type-check, so one at runtime means a catalog was
 * edited without `tsc`. It renders as `namespace.key` (visible, greppable) and
 * logs in development; production stays quiet rather than throwing mid-render.
 */
export const getTranslator = <N extends Namespace>(
  locale: ClientLocale,
  namespace: N,
): Translator<N> => {
  const key = `${locale}:${namespace}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as Translator<N>;

  const translator = createTranslator({
    locale: icuLocale(locale),
    messages: getMessages(locale),
    namespace,
    timeZone: timeZone(),
    onError: (error) => {
      if (isDev) console.error(`[i18n] ${error.message}`);
    },
    getMessageFallback: ({ namespace: ns, key: messageKey }) =>
      ns ? `${ns}.${messageKey}` : messageKey,
  }) as unknown as Translator<N>;

  cache.set(key, translator);
  return translator;
};
