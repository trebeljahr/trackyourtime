import type { Metadata } from "next";

import { SubscribeForm } from "@/components/subscribe-form";
import { marketingT } from "@/i18n/marketing";

import { SubscribeIntro } from "./subscribe-intro";

/**
 * Metadata is built once, in English: this page is not one of the per-language
 * public pages, and its body follows the reader's language at runtime instead.
 */
export function generateMetadata(): Metadata {
  const t = marketingT("en");
  return {
    title: t("newsletter.subscribe.metaTitle"),
    description: t("newsletter.subscribe.metaDescription"),
    alternates: { canonical: "/sub" },
    robots: { index: false, follow: false },
  };
}

export default function SubscribePage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-16">
      <SubscribeIntro />

      <section>
        <div className="rounded-lg border p-5 md:p-6">
          <SubscribeForm />
        </div>
      </section>
    </div>
  );
}
