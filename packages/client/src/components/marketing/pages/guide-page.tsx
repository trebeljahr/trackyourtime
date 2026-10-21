import type { Metadata } from "next";
import Link from "next/link";
import { Hero, PrimaryLink, Prose, Section, Shot } from "@/components/marketing/blocks";
import { GUIDES } from "@/components/marketing/guide-content";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingHref, marketingMetadata, type Locale } from "@/i18n/marketing";

export function guideMetadata(locale: Locale, slug: string): Metadata {
  const guide = GUIDES[locale][slug];
  if (!guide) throw new Error(`Missing ${locale} guide: ${slug}`);
  return marketingMetadata(locale, { title: guide.title, description: guide.description, path: `/${slug}/` });
}

export function GuidePage({ locale, slug }: { locale: Locale; slug: string }): React.ReactElement {
  const guide = GUIDES[locale][slug];
  if (!guide) throw new Error(`Missing ${locale} guide: ${slug}`);
  const href = (target: string): string => target.startsWith("/") ? marketingHref(locale, target) : target;
  return <MarketingShell locale={locale} path={`/${slug}/`}>
    <Hero eyebrow="Track Your Time" title={guide.title}
      actions={<PrimaryLink href={slug === "self-hosting" ? "https://trackyourtime.dev/docs/self-hosting/" : "/signup/"}>
        {slug === "self-hosting" ? (locale === "de" ? "Installation lesen (Englisch)" : "Read the installation guide")
          : (locale === "de" ? "Kostenloses Konto erstellen" : "Create a free account")}
      </PrimaryLink>}
      shot={guide.shot ? <Shot src={`/marketing/${guide.shot}.png`}
        alt={locale === "de" ? "Track Your Time in der App" : "Track Your Time in the app"}
        width={guide.shot === "phone-track" ? 645 : 1600} height={guide.shot === "phone-track" ? 1436 : 1000}
        className={guide.shot === "phone-track" ? "max-w-xs" : undefined} priority /> : undefined}>
      <p>{guide.intro}</p>
    </Hero>
    {guide.sections.map((section) => <Section key={section.title} title={section.title}>
      <Prose>
        {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {section.steps && <ol className="list-decimal space-y-3 pl-6">
          {section.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>}
        {section.code && <pre className="overflow-x-auto rounded-lg bg-muted p-5 text-sm text-foreground"><code>{section.code}</code></pre>}
        {section.links?.map((item) => <p key={item.href}><a href={href(item.href)} className="text-foreground underline underline-offset-4">{item.label}</a></p>)}
      </Prose>
    </Section>)}
    <Section title={locale === "de" ? "Passende Anleitungen" : "Related guides"} className="pb-24">
      <ul className="max-w-2xl divide-y">
        {guide.related.map((related) => <li key={related} className="py-4">
          <Link className="underline underline-offset-4" href={marketingHref(locale, `/${related}/`)}>
            {GUIDES[locale][related]?.title ?? ({ mobile: locale === "de" ? "iPhone und Android" : "iPhone and Android", support: locale === "de" ? "Hilfe" : "Support" }[related] ?? related)}
          </Link>
        </li>)}
      </ul>
    </Section>
  </MarketingShell>;
}
