/**
 * The report PDF's own translator, so the renderer needs no server.
 *
 * Same ICU engine (`use-intl/core`) and same catalogs the server used, lifted
 * here whole. The server keeps `serverT(locale, "report")` working by
 * importing these catalogs into `serverMessages`, so the catalog parity test
 * still covers them; nothing about the rendered text changes.
 *
 * Time zone is UTC unless given: a PDF has no viewer to take a zone from, and
 * dates on a report are calendar dates, formatted before they reach a
 * message. Missing messages render as `report.key` and never throw — a
 * half-rendered report is recoverable, a 500 on the download is not.
 */
import { createTranslator, type _Translator } from "use-intl/core";
import { DEFAULT_LOCALE, type Locale } from "@starter/shared";

import { report as deReport } from "./messages/de/report.js";
import { report as enReport } from "./messages/en/report.js";

export const reportMessages = {
  en: { report: enReport },
  de: { report: deReport },
} as const;

export type ReportMessages = (typeof reportMessages)["en"];
export type ReportTranslator = _Translator<ReportMessages, "report">;

const cache = new Map<string, ReportTranslator>();

/**
 * A translator for the `report` catalog in `locale` (an report without one
 * predates localisation and was English).
 */
export const reportT = (
  locale: Locale | null | undefined,
  timeZone = "UTC",
): ReportTranslator => {
  const resolved: Locale = locale ?? DEFAULT_LOCALE;
  const key = `${resolved}:${timeZone}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const translator = createTranslator({
    locale: resolved,
    messages: reportMessages[resolved] as unknown as ReportMessages,
    namespace: "report",
    timeZone,
    onError: () => undefined,
    getMessageFallback: ({ namespace, key: messageKey }) =>
      namespace ? `${namespace}.${messageKey}` : messageKey,
  }) as unknown as ReportTranslator;
  cache.set(key, translator);
  return translator;
};
