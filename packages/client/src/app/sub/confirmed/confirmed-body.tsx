"use client";

import Link from "next/link";

import { useT } from "@/i18n/use-t";

/** /sub/confirmed, in the reader's language. */
export function ConfirmedBody(): React.ReactElement {
  const t = useT("marketing");
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl md:text-4xl font-semibold">{t("newsletter.confirmed.title")}</h1>
      <p className="mt-3 text-gray-600">{t("newsletter.confirmed.confirmed")}</p>
      <p className="mt-2 text-gray-600">{t("newsletter.confirmed.cadence")}</p>
      <p className="mt-8 flex justify-center gap-6 text-sm">
        <Link href="/" className="underline underline-offset-2 hover:opacity-70">
          {t("newsletter.backToSite")}
        </Link>
      </p>
    </div>
  );
}
