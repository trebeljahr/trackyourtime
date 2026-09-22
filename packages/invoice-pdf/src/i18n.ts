/**
 * The invoice PDF's own translator, so the renderer needs no server.
 *
 * Same ICU engine (`use-intl/core`) and same catalogs the server used, lifted
 * here whole. The server keeps `serverT(locale, "invoice")` working by
 * importing these catalogs into `serverMessages`, so the catalog parity test
 * still covers them; nothing about the rendered text changes.
 *
 * Time zone is UTC unless given: a PDF has no viewer to take a zone from, and
 * dates on an invoice are calendar dates, formatted before they reach a
 * message. Missing messages render as `invoice.key` and never throw — a
 * half-rendered invoice is recoverable, a 500 on the download is not.
 */
import { createTranslator, type _Translator } from "use-intl/core";
import { DEFAULT_LOCALE, type Locale } from "@starter/shared";

import { invoice as deInvoice } from "./messages/de/invoice.js";
import { invoice as enInvoice } from "./messages/en/invoice.js";

export const invoiceMessages = {
  en: { invoice: enInvoice },
  de: { invoice: deInvoice },
} as const;

export type InvoiceMessages = (typeof invoiceMessages)["en"];
export type InvoiceTranslator = _Translator<InvoiceMessages, "invoice">;

const cache = new Map<string, InvoiceTranslator>();

/**
 * A translator for the `invoice` catalog in `locale` (an invoice without one
 * predates localisation and was English).
 */
export const invoiceT = (
  locale: Locale | null | undefined,
  timeZone = "UTC",
): InvoiceTranslator => {
  const resolved: Locale = locale ?? DEFAULT_LOCALE;
  const key = `${resolved}:${timeZone}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const translator = createTranslator({
    locale: resolved,
    messages: invoiceMessages[resolved] as unknown as InvoiceMessages,
    namespace: "invoice",
    timeZone,
    onError: () => undefined,
    getMessageFallback: ({ namespace, key: messageKey }) =>
      namespace ? `${namespace}.${messageKey}` : messageKey,
  }) as unknown as InvoiceTranslator;
  cache.set(key, translator);
  return translator;
};
