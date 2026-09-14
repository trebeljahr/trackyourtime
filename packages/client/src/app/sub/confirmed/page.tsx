import type { Metadata } from "next";

import { marketingT } from "@/i18n/marketing";

import { ConfirmedBody } from "./confirmed-body";

/** English metadata; the body follows the reader's language at runtime. */
export function generateMetadata(): Metadata {
  return {
    title: marketingT("en")("newsletter.confirmed.metaTitle"),
    robots: { index: false, follow: false },
  };
}

export default function ConfirmedPage(): React.ReactElement {
  return <ConfirmedBody />;
}
