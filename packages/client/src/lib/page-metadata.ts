import type { Metadata } from "next";

export const OG_IMAGE = {
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: "Track Your Time — open-source time tracking on your own server",
} as const;

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
}: {
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
      images: [OG_IMAGE],
    },
    twitter: { card: "summary_large_image", title: cardTitle, description, images: [OG_IMAGE.url] },
  };
}
