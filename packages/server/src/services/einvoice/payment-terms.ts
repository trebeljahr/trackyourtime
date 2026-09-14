// BT-20, payment terms: the same sentence the plain PDF prints under its
// payment details, frozen onto the invoice at create or fill so the PDF and
// the e-invoice can never state different terms.
import type { Locale } from "@starter/shared";
import { serverT } from "../../i18n/index.js";

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})/;
const DAY_MS = 86_400_000;

/**
 * The due date as the invoice PDF prints every date: ISO in English,
 * `15.09.2026` in German. The same output as main's `pdfFormat(locale).date`
 * (services/pdf-format.ts), which this defers to once the branch is rebased
 * onto it — the sentence and the page's due-date row must never differ.
 * The calendar date is the UTC one, as the router stores dates.
 */
export function paymentTermsDate(locale: Locale | null | undefined, dateIso: string): string {
  const match = DAY_KEY.exec(dateIso);
  if (!match) return dateIso.slice(0, 10);
  const [, year, month, day] = match;
  return locale === "de" ? `${day}.${month}.${year}` : `${year}-${month}-${day}`;
}

const dayNumber = (dateIso: string): number | null => {
  const match = DAY_KEY.exec(dateIso);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS : null;
};

/**
 * "Payable within 14 days, by 2026-09-28." / "Zahlbar bis zum 28.09.2026." in
 * the invoice's language. Both dates are the STORED ISO values
 * (`Date#toISOString()`), never a request string with an offset.
 *
 * With `issueDateIso`, the terms are named only when the due date really is
 * the issue date plus those days: a due date moved off the suggestion reads
 * "Payable by <date>." rather than a term that contradicts its own date.
 * Without it — the plain PDF re-rendering an invoice that stores no sentence —
 * the wording is the one main always printed. No catalog string starts a line
 * with "#", which XRechnung reads as a discount term (BR-DE-18).
 */
export function paymentTermsSentence(
  locale: Locale | null | undefined,
  paymentTermsDays: number | null,
  dueDateIso: string,
  options: { issueDateIso?: string } = {},
): string {
  const t = serverT(locale, "invoice");
  const date = paymentTermsDate(locale, dueDateIso);
  if (paymentTermsDays === null) return t("dueBy", { date });
  if (options.issueDateIso !== undefined) {
    const issued = dayNumber(options.issueDateIso);
    const due = dayNumber(dueDateIso);
    if (issued === null || due === null || due - issued !== paymentTermsDays) {
      return t("dueBy", { date });
    }
  }
  return t("dueWithinTerms", { days: paymentTermsDays, date });
}
