"use client";

import Link from "next/link";
import { Suspense } from "react";

import { useT } from "@/i18n/use-t";

import { ReasonMessage } from "./reason-message";

/** /sub/error, in the reader's language. */
export function ErrorBody(): React.ReactElement {
  const t = useT("marketing");
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl md:text-4xl font-semibold">{t("newsletter.error.title")}</h1>
      <Suspense fallback={<p className="mt-4 text-gray-600">&nbsp;</p>}>
        <ReasonMessage />
      </Suspense>
      <p className="mt-8 flex justify-center gap-6 text-sm">
        <Link href="/sub" className="underline underline-offset-2 hover:opacity-70">
          {t("newsletter.error.tryAgain")}
        </Link>
        <Link href="/" className="underline underline-offset-2 hover:opacity-70">
          {t("newsletter.backToSite")}
        </Link>
      </p>
    </div>
  );
}
