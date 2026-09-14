import type { Metadata } from "next";

import { marketingT } from "@/i18n/marketing";

import { ErrorBody } from "./error-body";

/** English metadata; the body follows the reader's language at runtime. */
export function generateMetadata(): Metadata {
  return {
    title: marketingT("en")("newsletter.error.metaTitle"),
    robots: { index: false, follow: false },
  };
}

export default function ErrorPage(): React.ReactElement {
  return <ErrorBody />;
}
