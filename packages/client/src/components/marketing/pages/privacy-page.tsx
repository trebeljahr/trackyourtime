import type { Metadata } from "next";

import { Hero, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { DATE_STYLES } from "@/i18n/format";
import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { CONTACT_EMAIL, REPO_URL } from "@/lib/site-links";

/** Metadata for one locale of this page. `path` stays the English path. */
export const privacyMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("privacy.meta.title"),
    description: t("privacy.meta.description"),
    path: "/privacy/",
  });
};

/** Bump when the policy changes in substance. Store listings link to this page. */
const LAST_UPDATED = Date.UTC(2026, 8, 15);

/**
 * The date in the page's language, identical on every build machine.
 *
 * Not `formatDate`: that follows the device's region, and at build time the
 * "device" is whichever machine runs `next build` (Node has a `navigator`), so
 * the served HTML would change with it. A fixed region per language and UTC on
 * both sides of the formatter pin it. en-GB keeps the day-month order this
 * page has always used.
 */
const DATE_REGION: Record<Locale, string> = { en: "en-GB", de: "de-DE" };

const lastUpdated = (locale: Locale): string =>
  new Intl.DateTimeFormat(DATE_REGION[locale], { ...DATE_STYLES.long, timeZone: "UTC" }).format(
    LAST_UPDATED,
  );

const link = "text-foreground underline underline-offset-4";

function Block({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Section title={title} className="py-8">
      <div className="max-w-2xl space-y-4 leading-relaxed text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground [&_ul]:space-y-2">
        {children}
      </div>
    </Section>
  );
}

export function PrivacyPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  const strong = (chunks: React.ReactNode): React.ReactElement => <strong>{chunks}</strong>;
  const mail = (chunks: React.ReactNode): React.ReactElement => (
    <a href={`mailto:${CONTACT_EMAIL}`} className={link}>
      {chunks}
    </a>
  );
  return (
    <MarketingShell locale={locale} path="/privacy/">
      <Hero
        // Formatted to a string first: a date inside an ICU argument would be
        // formatted in the build machine's zone.
        eyebrow={t("privacy.hero.lastUpdated", { date: lastUpdated(locale) })}
        title={t("privacy.hero.title")}
      >
        <p>{t("privacy.hero.scope")}</p>
        <p>{t.rich("privacy.hero.contact", { email: CONTACT_EMAIL, mail })}</p>
      </Hero>

      <Block title={t("privacy.summary.title")}>
        <ul>
          <li>{t("privacy.summary.stores")}</li>
          <li>{t("privacy.summary.noAnalytics")}</li>
          <li>{t("privacy.summary.noTracking")}</li>
          <li>{t("privacy.summary.control")}</li>
        </ul>
      </Block>

      <Block title={t("privacy.stored.title")}>
        <p>{t.rich("privacy.stored.account", { strong })}</p>
        <p>{t.rich("privacy.stored.tracked", { strong })}</p>
        <p>{t.rich("privacy.stored.settings", { strong })}</p>
        <p>{t.rich("privacy.stored.sessions", { strong })}</p>
        <p>{t.rich("privacy.stored.tokens", { strong })}</p>
        <p>{t.rich("privacy.stored.logs", { strong })}</p>
      </Block>

      <Block title={t("privacy.purpose.title")}>
        <p>{t("privacy.purpose.contract")}</p>
        <p>{t("privacy.purpose.interest")}</p>
        <p>{t("privacy.purpose.newsletter")}</p>
      </Block>

      <Block title={t("privacy.processors.title")}>
        <ul>
          <li>{t.rich("privacy.processors.cloudflare", { strong })}</li>
          <li>{t.rich("privacy.processors.ses", { strong })}</li>
          <li>{t.rich("privacy.processors.host", { strong })}</li>
        </ul>
        <p>{t("privacy.processors.nobodyElse")}</p>
      </Block>

      <Block title={t("privacy.extension.title")}>
        <ul>
          <li>{t("privacy.extension.storage")}</li>
          <li>{t.rich("privacy.extension.cookies", { strong })}</li>
          <li>{t.rich("privacy.extension.idle", { strong })}</li>
          <li>{t("privacy.extension.network")}</li>
          <li>{t.rich("privacy.extension.activity", { strong })}</li>
          <li>{t("privacy.extension.limitedUse")}</li>
        </ul>
      </Block>

      <Block title={t("privacy.raycast.title")}>
        <p>{t("privacy.raycast.body")}</p>
      </Block>

      <Block title={t("privacy.mobile.title")}>
        <ul>
          <li>{t("privacy.mobile.keychain")}</li>
          <li>{t("privacy.mobile.storage")}</li>
          <li>{t("privacy.mobile.permissions")}</li>
          <li>{t("privacy.mobile.noTracking")}</li>
        </ul>
      </Block>

      <Block title={t("privacy.retention.title")}>
        <p>{t("privacy.retention.body")}</p>
      </Block>

      <Block title={t("privacy.rights.title")}>
        <p>{t.rich("privacy.rights.copy", { strong })}</p>
        <p>{t.rich("privacy.rights.correct", { strong })}</p>
        <p>{t.rich("privacy.rights.delete", { strong })}</p>
        <p>{t.rich("privacy.rights.noSignIn", { email: CONTACT_EMAIL, mail })}</p>
        <p>{t("privacy.rights.eu")}</p>
      </Block>

      <Block title={t("privacy.children.title")}>
        <p>{t("privacy.children.body")}</p>
      </Block>

      <Block title={t("privacy.changes.title")}>
        <p>
          {t.rich("privacy.changes.body", {
            repo: (chunks) => (
              <a href={REPO_URL} className={link}>
                {chunks}
              </a>
            ),
          })}
        </p>
      </Block>
      <div className="pb-16" />
    </MarketingShell>
  );
}
