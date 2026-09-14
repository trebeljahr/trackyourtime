import type { Metadata } from "next";

import { NotFoundView } from "@/components/not-found-view";
import { getTranslator } from "@/i18n/translator";

/**
 * The tab title is English: the export writes one `404.html` for every
 * reader, and metadata is fixed at build time. The page body follows the
 * reader's language after hydration (see NotFoundView).
 */
export const metadata: Metadata = {
  title: getTranslator("en", "shell")("notFound.metaTitle"),
  robots: { index: false },
};

/**
 * The 404 for every host. The static export writes it to `out/404.html`,
 * which `serve.mjs` sends with a real 404 status.
 *
 * Deliberately NOT inside `MarketingShell`: that shell is hidden inside the
 * Capacitor app (`data-marketing` in native.css), and a phone that follows a
 * stale link must see a way back, not a blank screen. So the page offers the
 * tracker first — the one destination that is right on every host.
 */
export default function NotFound(): React.ReactElement {
  return <NotFoundView />;
}
