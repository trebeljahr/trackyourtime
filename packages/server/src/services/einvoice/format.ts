/**
 * Formatting for the e-invoice outputs.
 *
 * The pure, browser-safe helpers (numbers, dates, filenames) moved to
 * `@starter/invoice-pdf` so the invoice renderer and the public generator page
 * share one copy; they are re-exported here at the path the e-invoice code and
 * its tests already import from. The two XML-aware text helpers stay here,
 * because they depend on `stripInvalidXmlChars` (an XML concern, not a PDF one).
 */
export {
  formatPercent,
  formatDecimal,
  utcDateKey,
  localDateKey,
  lastBilledDateKey,
  billedPeriodDates,
  safeFilenamePart,
} from "@starter/invoice-pdf/format";

import { stripInvalidXmlChars } from "./xml.js";

/**
 * Free text for notes, payment terms and exemption reasons (BT-22, BT-20,
 * BT-120): invalid XML characters removed, CRLF/CR → LF, trailing whitespace
 * trimmed per line, the whole value trimmed. Inner newlines are kept.
 */
export function cleanText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return stripInvalidXmlChars(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
}

/** cleanText, then every whitespace run (newlines included) collapsed to one space. For names, address lines, ids. */
export function cleanLine(value: string | null | undefined): string {
  return cleanText(value).replace(/\s+/gu, " ");
}
