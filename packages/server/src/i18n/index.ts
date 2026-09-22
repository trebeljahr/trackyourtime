/**
 * Translated server text: invoice PDFs, report PDF exports and transactional
 * email.
 *
 * Separate from the web client's catalog on purpose. The server renders
 * documents that outlive any session — an invoice PDF is re-rendered months
 * later, in the language snapshotted on it — so its strings are keyed by the
 * document, not by a UI screen, and it must not import a React-facing
 * catalog. Same ICU engine (`use-intl/core`), same `Translation<>` typing and
 * the same parity test as the client, so a translator works the same way in
 * both.
 *
 * Deliberately NOT localised, whatever the locale: CSV exports and the
 * importer, REST/tRPC error codes and `problem+json` types, webhook payloads,
 * OpenAPI docs, log lines. Those are read by machines or by integrators who
 * key off exact strings.
 */
import { createTranslator, type _Translator } from "use-intl/core";
import { DEFAULT_LOCALE, type Locale } from "@starter/shared";

// The `invoice` catalog moved to `@starter/invoice-pdf` so the renderer runs
// in the browser too; it is re-imported here so `serverT(locale, "invoice")`
// and the catalog parity test still cover it.
import { invoice as deInvoice } from "@starter/invoice-pdf/messages/de/invoice";
import { invoice as enInvoice } from "@starter/invoice-pdf/messages/en/invoice";
import { email as deEmail } from "./messages/de/email.js";
import { report as deReport } from "./messages/de/report.js";
import { email as enEmail } from "./messages/en/email.js";
import { report as enReport } from "./messages/en/report.js";

export const serverMessages = {
  en: { invoice: enInvoice, email: enEmail, report: enReport },
  de: { invoice: deInvoice, email: deEmail, report: deReport },
} as const;

export type ServerMessages = (typeof serverMessages)["en"];
export type ServerNamespace = keyof ServerMessages;
export type ServerTranslator<N extends ServerNamespace> = _Translator<ServerMessages, N>;

const cache = new Map<string, unknown>();

/**
 * A translator for one server namespace. `locale` is the document's — for an
 * invoice, `invoice.locale ?? "en"` (an invoice without one predates
 * localisation and was English).
 *
 * Time zone is UTC unless given: a PDF has no viewer to take a zone from, and
 * dates on an invoice are calendar dates, formatted before they reach a
 * message. Missing messages render as `namespace.key` and never throw — a
 * half-rendered invoice is recoverable, a 500 on the download is not.
 */
export const serverT = <N extends ServerNamespace>(
  locale: Locale | null | undefined,
  namespace: N,
  timeZone = "UTC",
): ServerTranslator<N> => {
  const resolved: Locale = locale ?? DEFAULT_LOCALE;
  const key = `${resolved}:${namespace}:${timeZone}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as ServerTranslator<N>;

  const translator = createTranslator({
    locale: resolved,
    messages: serverMessages[resolved] as unknown as ServerMessages,
    namespace,
    timeZone,
    onError: () => undefined,
    getMessageFallback: ({ namespace: ns, key: messageKey }) =>
      ns ? `${ns}.${messageKey}` : messageKey,
  }) as unknown as ServerTranslator<N>;
  cache.set(key, translator);
  return translator;
};
