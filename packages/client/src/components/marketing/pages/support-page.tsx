import type { Metadata } from "next";
import Link from "next/link";

import { FactList, Hero, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { localizedPath, marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { CONTACT_EMAIL, ISSUES_URL, SELF_HOSTING_URL } from "@/lib/site-links";

/** Metadata for one locale of this page. `path` stays the English path. */
export const supportMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("support.meta.title"),
    description: t("support.meta.description"),
    path: "/support/",
  });
};

const link = "text-foreground underline underline-offset-4";

/** The questions, in the order they are shown. */
const FAQ = [
  "extensionSignIn",
  "raycastConnect",
  "waitingChanges",
  "lostDevice",
  "export",
  "deleteAccount",
  "selfHost",
] as const;

export function SupportPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  const tags = {
    privacy: (chunks: React.ReactNode): React.ReactElement => (
      <Link href={localizedPath(locale, "/privacy/")} className={link}>
        {chunks}
      </Link>
    ),
    guide: (chunks: React.ReactNode): React.ReactElement => (
      <a href={SELF_HOSTING_URL} className={link}>
        {chunks}
      </a>
    ),
  };
  return (
    <MarketingShell locale={locale} path="/support/">
      <Hero eyebrow={t("support.hero.eyebrow")} title={t("support.hero.title")}>
        <p>
          {t.rich("support.hero.email", {
            email: CONTACT_EMAIL,
            mail: (chunks) => (
              <a href={`mailto:${CONTACT_EMAIL}`} className={link}>
                {chunks}
              </a>
            ),
          })}
        </p>
        <p>
          {t.rich("support.hero.issues", {
            issues: (chunks) => (
              <a href={ISSUES_URL} className={link}>
                {chunks}
              </a>
            ),
          })}
        </p>
      </Hero>

      <Section title={t("support.faq.title")} className="pb-24">
        <FactList
          items={FAQ.map((key) => ({
            term: t(`support.faq.${key}.term`),
            detail:
              key === "deleteAccount"
                ? t.rich("support.faq.deleteAccount.detail", { privacy: tags.privacy })
                : key === "selfHost"
                  ? t.rich("support.faq.selfHost.detail", { guide: tags.guide })
                  : t(`support.faq.${key}.detail`),
          }))}
        />
      </Section>
    </MarketingShell>
  );
}
