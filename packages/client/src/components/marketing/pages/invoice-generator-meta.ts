import type { Metadata } from "next";

import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";

/**
 * Metadata for one locale of the invoice generator, kept out of
 * `invoice-generator-page.tsx` because that file is a Client Component. A
 * `"use client"` export cannot be called from a server route, and the route
 * wrappers evaluate this at build time — so it lives in its own server-safe
 * module. `path` stays the English path; the German slug pairing is in
 * i18n/marketing.ts.
 */
export const invoiceGeneratorMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("invoiceGenerator.meta.title"),
    description: t("invoiceGenerator.meta.description"),
    path: "/invoice-generator/",
  });
};
