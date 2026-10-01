import type { Metadata } from "next";

import { Hero, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, type Locale } from "@/i18n/marketing";
import { IMPRINT_EMAIL } from "@/lib/site-links";

export const imprintMetadata = (locale: Locale): Metadata =>
  marketingMetadata(locale, {
    title: locale === "de" ? "Impressum" : "Imprint",
    description: locale === "de" ? "Anbieter und Kontakt von Track Your Time." : "Provider and contact for Track Your Time.",
    path: "/imprint/",
  });

export function ImprintPage({ locale }: { locale: Locale }): React.ReactElement {
  const german = locale === "de";
  return (
    <MarketingShell locale={locale} path="/imprint/">
      <Hero eyebrow="Track Your Time" title={german ? "Impressum" : "Imprint"} />
      <Section title={german ? "Anbieter (§ 5 DDG)" : "Provider (§ 5 DDG)"}>
        <address className="not-italic leading-relaxed text-muted-foreground">
          Rico Trebeljahr<br />
          c/o Block Services<br />
          Stuttgarter Str. 106<br />
          70736 Fellbach<br />
          Germany
        </address>
      </Section>
      <Section title={german ? "Kontakt" : "Contact"}>
        <a className="underline underline-offset-4" href={`mailto:${IMPRINT_EMAIL}`}>{IMPRINT_EMAIL}</a>
      </Section>
      <Section title={german ? "Verantwortlich für den Inhalt (§ 18 Abs. 2 MStV)" : "Person responsible for content (§ 18 (2) MStV)"} className="pb-24">
        <address className="not-italic leading-relaxed text-muted-foreground">
          Rico Trebeljahr<br />
          c/o Block Services<br />
          Stuttgarter Str. 106<br />
          70736 Fellbach
        </address>
      </Section>
    </MarketingShell>
  );
}
