import { DATE_STYLES } from "@/i18n/format";

/**
 * "21 – 27 Aug 2026" / "21.–27. Aug. 2026" for a span of whole days, in the
 * reader's language and region.
 *
 * `Intl.DateTimeFormat#formatRange` collapses the shared month and year the
 * way each locale expects, which no hand-built "d – d MMM yyyy" pattern can.
 * `intlTag` is `useFormat().intlLocale`.
 */
export const formatDayRangeLabel = (from: Date, to: Date, intlTag: string): string => {
  const formatter = new Intl.DateTimeFormat(intlTag, DATE_STYLES.medium);
  try {
    return formatter.formatRange(from, to);
  } catch {
    return `${formatter.format(from)} – ${formatter.format(to)}`;
  }
};
