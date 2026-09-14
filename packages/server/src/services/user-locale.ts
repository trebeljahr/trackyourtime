/**
 * The language the server writes to a person in, when nothing about the
 * document itself decides it: a transactional email, a report export.
 *
 * Only an EXPLICIT preference counts. "system" is a device's answer — the web
 * app resolves it against `navigator.languages` — and the server has no device
 * to ask, so it reads as "not chosen" and English applies. Invoices do not come
 * through here: their language is `resolveInvoiceLocale`'s, snapshotted.
 */
import { DEFAULT_LOCALE, type Locale, type LocalePreference } from "@starter/shared";
import { UserPreferencesModel } from "../models/Settings.js";

/** A stored preference as a language, or `null` when none was chosen. */
export function explicitLocale(preference: LocalePreference | null | undefined): Locale | null {
  return preference && preference !== "system" ? preference : null;
}

/**
 * The first of these people with an explicit preference, else English.
 *
 * Takes a list so a caller can name a fallback person — an invitation to an
 * address with no account yet is written in the inviter's language, the
 * likeliest one the two share. A failed lookup is English, never an error: a
 * password reset that does not arrive because a preference could not be read
 * is far worse than one in the wrong language.
 */
export async function preferredLocale(
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Locale> {
  const ids = userIds.filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length === 0) return DEFAULT_LOCALE;
  try {
    const rows = await UserPreferencesModel.find({ userId: { $in: ids } })
      .select("userId locale")
      .lean();
    const byUser = new Map(rows.map((row) => [row.userId, explicitLocale(row.locale)]));
    for (const id of ids) {
      const locale = byUser.get(id);
      if (locale) return locale;
    }
  } catch {
    // English; see above.
  }
  return DEFAULT_LOCALE;
}
