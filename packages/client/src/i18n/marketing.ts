/**
 * The public pages in more than one language, as static files.
 *
 * Every public page exists once per locale: English at the root (`/privacy/`),
 * German under `/de/` (`/de/privacy/`). Both are server components rendered at
 * BUILD time with a fixed locale, so the HTML a crawler or a link preview
 * fetches is already in its language — no JavaScript, no preference, no
 * switch after load. The app routes (/track, /login, …) are the opposite:
 * one file each, following the reader's preference at runtime.
 *
 * Why not a `[locale]` segment: it would sit at the root beside `/track` and
 * `/login`, every static route would have to out-rank it, and an unknown
 * first segment would render a marketing layout instead of the 404. Explicit
 * `app/de/**` files are six one-line re-exports and cannot capture anything.
 *
 * What the German files cannot do is change `<html lang>` in the served HTML:
 * that element belongs to the ONE root layout, and giving /de/ its own root
 * layout means moving every route into route groups. Instead the page content
 * carries `lang="de"` (on the <FixedLocale> wrapper), LOCALE_SCRIPT sets
 * `<html lang="de">` before paint, and the metadata declares `og:locale` and
 * hreflang alternates — which is what search engines use to pair the two.
 *
 * Server-safe: no React state, no browser APIs.
 */
import type { Metadata } from "next";
import { SUPPORTED_LOCALES, type Locale } from "@starter/shared";

import { getTranslator, type Translator } from "@/i18n/translator";
import { pageMetadata } from "@/lib/page-metadata";

export type { Locale };

/** Every locale a public page is built in, in hreflang order. */
export const MARKETING_LOCALES: readonly Locale[] = SUPPORTED_LOCALES;

/** Open Graph wants a region. */
const OG_LOCALE: Record<Locale, string> = { en: "en_US", de: "de_DE" };

/**
 * The URL of a public page in a locale: `localizedPath("de", "/privacy/")` is
 * "/de/privacy/", and "/" becomes "/de/". English is unprefixed. Use it for
 * EVERY internal link on a public page, so a German reader stays German.
 * Links into the app (/login/, /signup/) are not public pages — pass them
 * through unchanged.
 */
export const localizedPath = (locale: Locale, path: string): string => {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  if (locale === "en") return normalised;
  return normalised === "/" ? `/${locale}/` : `/${locale}${normalised}`;
};

/** The `marketing` translator for a build-time render. */
export const marketingT = (locale: Locale): Translator<"marketing"> =>
  getTranslator(locale, "marketing");

/**
 * `pageMetadata` for one locale of a public page, plus what ties the
 * translations together: a canonical URL per locale, `hreflang` alternates for
 * every locale and `x-default` (English), and `og:locale`.
 *
 * `path` is the ENGLISH path ("/privacy/"); the localised one is derived.
 * Title and description are already-translated strings — typically
 * `marketingT(locale)("privacy.meta.title")`.
 */
export const marketingMetadata = (
  locale: Locale,
  {
    title,
    description,
    path,
  }: {
    title: string | { absolute: string };
    description: string;
    path: string;
  },
): Metadata => {
  const base = pageMetadata({ title, description, path: localizedPath(locale, path) });
  const languages: Record<string, string> = { "x-default": localizedPath("en", path) };
  for (const each of MARKETING_LOCALES) languages[each] = localizedPath(each, path);
  return {
    ...base,
    alternates: { ...base.alternates, languages },
    openGraph: {
      ...base.openGraph,
      locale: OG_LOCALE[locale],
      alternateLocale: MARKETING_LOCALES.filter((each) => each !== locale).map(
        (each) => OG_LOCALE[each],
      ),
    },
  };
};
