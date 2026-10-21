import { Children, isValidElement, type ReactNode } from "react";

/** Escape HTML delimiters so catalog copy can never terminate a script element. */
export function StructuredData({ data }: { data: unknown }): React.ReactElement {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{
    __html: JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"),
  }} />;
}

export type FaqItem = { q: string; a: React.ReactNode };

function textOf(node: ReactNode): string {
  return Children.toArray(node).map((child) =>
    isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : String(child),
  ).join("");
}

/** The same rendered answer as the visible FAQ, including its links. */
export function faqData(items: readonly FaqItem[], language: string, url: string): unknown {
  return {
    "@context": "https://schema.org", "@type": "FAQPage", inLanguage: language, url,
    mainEntity: items.map(({ q, a }) => ({
      "@type": "Question", name: q,
      acceptedAnswer: { "@type": "Answer", text: textOf(a) },
    })),
  };
}
