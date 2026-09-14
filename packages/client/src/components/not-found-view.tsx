"use client";

import * as React from "react";
import Link from "next/link";

import { BrandLockup } from "@/components/brand-lockup";
import { useT } from "@/i18n/use-t";

/**
 * The body of app/not-found.tsx.
 *
 * A client component so it follows the reader's language: the 404 is
 * prerendered once, in English, and switches after hydration like every other
 * screen inside the locale gate. The route file stays a server component
 * because it exports `metadata`.
 */
export function NotFoundView(): React.JSX.Element {
  const t = useT("shell");
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6" data-testid="not-found">
        <Link href="/" aria-label={t("notFound.homeLabel")}>
          <BrandLockup />
        </Link>
        <div className="space-y-3">
          <p className="text-sm font-medium text-brand">404</p>
          <h1 className="text-3xl font-semibold tracking-tight">{t("notFound.title")}</h1>
          <p className="leading-relaxed text-muted-foreground">{t("notFound.body")}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/track/"
            className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("notFound.openTracker")}
          </Link>
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-md border px-5 text-sm font-medium hover:bg-accent"
          >
            {t("notFound.home")}
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          {t.rich("notFound.report", {
            link: (chunks) => (
              <Link href="/support/" className="text-foreground underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </main>
  );
}
