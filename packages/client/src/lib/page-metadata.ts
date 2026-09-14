import type { Metadata } from "next";
import type { Locale } from "@starter/shared";

import { getTranslator } from "@/i18n/translator";

export type OgImage = { url: string; width: number; height: number; alt: string };

/** The link-preview card, with its description in `locale`. */
export const ogImage = (locale: Locale): OgImage => ({
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: getTranslator(locale, "marketing")("meta.ogImageAlt"),
});

/** The English card, for the root layout and every page without a language of its own. */
export const OG_IMAGE: OgImage = ogImage("en");

/**
 * Metadata for a public page.
 *
 * Next replaces a parent's `openGraph` wholesale rather than merging it, and
 * never derives `og:title` from `title`. So a page that sets only a title
 * and a description shares the layout's card with no title of its own, and a
 * link to /raycast previews as the home page. Every public page builds its
 * metadata here instead.
 */
export function pageMetadata({
  title,
  description,
  path,
  locale = "en",
}: {
  /** The language of the page, for the preview card's image description. */
  locale?: Locale;
  /** Shown in the tab as "<title> | Track Your Time"; the landing page passes an absolute title. */
  title: string | { absolute: string };
  description: string;
  path: string;
}): Metadata {
  const cardTitle = typeof title === "string" ? `${title} | Track Your Time` : title.absolute;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Track Your Time",
      url: path,
      title: cardTitle,
      description,
      images: [ogImage(locale)],
    },
    twitter: { card: "summary_large_image", title: cardTitle, description, images: [OG_IMAGE.url] },
  };
}
