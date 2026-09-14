import type { Metadata } from "next";

import { Hero, Prose, Section, Shot, StoreLink } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";

/** Metadata for one locale of this page. `path` stays the English path. */
export const mobileMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("mobile.meta.title"),
    description: t("mobile.meta.description"),
    path: "/mobile/",
  });
};

export function MobilePage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  return (
    <MarketingShell locale={locale} path="/mobile/">
      <Hero
        eyebrow={t("mobile.hero.eyebrow")}
        title={t("mobile.hero.title")}
        actions={
          <>
            <StoreLink store="appStore" locale={locale} />
            <StoreLink store="googlePlay" locale={locale} />
          </>
        }
        shot={
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:max-w-4xl">
            <Shot
              src="/marketing/phone-track.png"
              alt={t("mobile.hero.trackShotAlt")}
              width={645}
              height={1436}
              priority
            />
            <Shot
              src="/marketing/phone-reports.png"
              alt={t("mobile.hero.reportsShotAlt")}
              width={645}
              height={1436}
            />
            <Shot
              src="/marketing/phone-more.png"
              alt={t("mobile.hero.menuShotAlt")}
              width={645}
              height={1436}
              className="hidden sm:block"
            />
          </div>
        }
      >
        <p>{t("mobile.hero.body")}</p>
      </Hero>

      <Section title={t("mobile.offline.title")}>
        <Prose>
          <p>{t("mobile.offline.body")}</p>
        </Prose>
      </Section>

      <Section title={t("mobile.wholeApp.title")}>
        <Prose>
          <p>{t("mobile.wholeApp.body")}</p>
        </Prose>
      </Section>

      <Section title={t("mobile.lost.title")}>
        <Prose>
          <p>{t("mobile.lost.body")}</p>
        </Prose>
      </Section>

      <Section title={t("mobile.selfHost.title")} className="pb-24">
        <Prose>
          <p>{t("mobile.selfHost.body")}</p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
