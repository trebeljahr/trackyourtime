import type { Metadata } from "next";

import {
  Bullets,
  Feature,
  Hero,
  Prose,
  SecondaryLink,
  Section,
  Shot,
  StoreLink,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { SELF_HOSTING_URL } from "@/lib/site-links";

/** Metadata for one locale of this page. `path` stays the English path. */
export const extensionMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("extension.meta.title"),
    description: t("extension.meta.description"),
    path: "/extension/",
  });
};

export function ExtensionPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  return (
    <MarketingShell locale={locale} path="/extension/">
      <Hero
        eyebrow={t("extension.hero.eyebrow")}
        title={t("extension.hero.title")}
        actions={
          <>
            <StoreLink store="chrome" locale={locale} />
            <SecondaryLink href="/signup/">{t("extension.hero.createAccount")}</SecondaryLink>
          </>
        }
      >
        <p>{t("extension.hero.body")}</p>
      </Hero>

      <Feature
        title={t("extension.recent.title")}
        shot={
          <Shot
            src="/marketing/popup.png"
            alt={t("extension.recent.shotAlt")}
            width={760}
            height={1200}
            className="mx-auto max-w-xs"
          />
        }
      >
        <p>{t("extension.recent.recents")}</p>
        <p>{t("extension.recent.suggestions")}</p>
      </Feature>

      <Section title={t("extension.fixDay.title")}>
        <Prose>
          <p>{t("extension.fixDay.body")}</p>
        </Prose>
      </Section>

      <Section title={t("extension.offline.title")}>
        <Prose>
          <p>{t("extension.offline.body")}</p>
        </Prose>
      </Section>

      <Section title={t("extension.login.title")}>
        <Prose>
          <p>{t("extension.login.body")}</p>
        </Prose>
      </Section>

      <Section title={t("extension.selfHost.title")}>
        <Prose>
          <p>
            {t.rich("extension.selfHost.body", {
              guide: (chunks) => (
                <a
                  href={`${SELF_HOSTING_URL}#10-the-other-clients`}
                  className="text-foreground underline underline-offset-4"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
        </Prose>
      </Section>

      <Section title={t("extension.permissions.title")} className="pb-24">
        <Bullets
          items={[
            t("extension.permissions.login"),
            t("extension.permissions.idle"),
            t("extension.permissions.storage"),
            t("extension.permissions.server"),
          ]}
        />
      </Section>
    </MarketingShell>
  );
}
