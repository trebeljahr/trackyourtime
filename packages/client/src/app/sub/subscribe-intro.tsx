"use client";

import { useT } from "@/i18n/use-t";

/** The heading of /sub, in the reader's language. */
export function SubscribeIntro(): React.ReactElement {
  const t = useT("marketing");
  return (
    <header className="mb-8">
      <h1 className="text-3xl md:text-4xl font-semibold">{t("newsletter.subscribe.title")}</h1>
      <p className="mt-3 text-gray-600">{t("newsletter.subscribe.intro")}</p>
    </header>
  );
}
