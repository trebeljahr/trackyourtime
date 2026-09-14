import type { Metadata } from "next";

import { Hero, Prose, SecondaryLink, Section, StoreLink } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";

/** Metadata for one locale of this page. `path` stays the English path. */
export const raycastMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("raycast.meta.title"),
    description: t("raycast.meta.description"),
    path: "/raycast/",
  });
};

/** Raycast's "Log Past Time" shortcut. Keys are not translated. */
const LOG_PAST_SHORTCUT = "⌘ ⇧ N";

export function RaycastPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  return (
    <MarketingShell locale={locale} path="/raycast/">
      <Hero
        eyebrow={t("raycast.hero.eyebrow")}
        title={t("raycast.hero.title")}
        actions={
          <>
            <StoreLink store="raycast" locale={locale} />
            <SecondaryLink href="/signup/">{t("raycast.hero.createAccount")}</SecondaryLink>
          </>
        }
      >
        <p>{t("raycast.hero.body")}</p>
      </Hero>

      <Section title={t("raycast.menuBar.title")}>
        <Prose>
          <p>{t("raycast.menuBar.body")}</p>
        </Prose>
      </Section>

      <Section title={t("raycast.hotkey.title")}>
        <Prose>
          <p>{t("raycast.hotkey.body")}</p>
        </Prose>
      </Section>

      <Section title={t("raycast.logPast.title")}>
        <Prose>
          <p>
            {t.rich("raycast.logPast.body", {
              shortcut: LOG_PAST_SHORTCUT,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </Prose>
      </Section>

      <Section title={t("raycast.offline.title")}>
        <Prose>
          <p>{t("raycast.offline.body")}</p>
        </Prose>
      </Section>

      <Section title={t("raycast.connect.title")} className="pb-24">
        <Prose>
          <p>{t("raycast.connect.pairing")}</p>
          <p>{t("raycast.connect.selfHost")}</p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
