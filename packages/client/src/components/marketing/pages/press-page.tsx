import type { Metadata } from "next";

import {
  Bullets,
  FactList,
  Hero,
  PrimaryLink,
  Prose,
  SecondaryLink,
  Section,
  Shot,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { CONTACT_EMAIL, REPO_URL } from "@/lib/site-links";

/** Metadata for one locale of this page. `path` stays the English path. */
export const pressMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("press.meta.title"),
    description: t("press.meta.description"),
    path: "/press/",
  });
};

/**
 * The archive `scripts/marketing/build-press-kit-zip.mjs` writes into
 * `public/`, served from the export like any other public file. It is
 * committed, because neither the web build nor the Docker image runs the
 * builder — see that script's header.
 */
const PRESS_KIT_HREF = "/press-kit.zip";

/**
 * What is in the kit's `marketing/` folder, in the order the page shows it,
 * with each file's real pixel size. These are the SAME files the other public
 * pages serve — `docs/marketing/README.md` says why they cannot move — so a
 * rename here and there breaks the landing page too.
 */
const SHOTS = [
  { key: "webTrack", src: "/marketing/web-track.png", width: 1600, height: 1000 },
  { key: "webTimesheet", src: "/marketing/web-timesheet.png", width: 1600, height: 1000 },
  { key: "webCalendar", src: "/marketing/web-calendar.png", width: 1600, height: 1000 },
  { key: "webReports", src: "/marketing/web-reports.png", width: 1600, height: 1000 },
  { key: "webInvoice", src: "/marketing/web-invoice.png", width: 1600, height: 1000 },
  { key: "phoneTrack", src: "/marketing/phone-track.png", width: 645, height: 1436 },
  { key: "phoneReports", src: "/marketing/phone-reports.png", width: 645, height: 1436 },
  { key: "phoneMore", src: "/marketing/phone-more.png", width: 645, height: 1436 },
  { key: "popup", src: "/marketing/popup.png", width: 760, height: 1200 },
] as const;

/** What the kit holds, one line each. */
const CONTENTS = ["screenshots", "brand", "icons", "factSheet"] as const;

/** The short facts a writer checks before publishing. */
const FACTS = ["price", "licence", "platforms", "status", "madeBy", "source"] as const;

const link = "text-foreground underline underline-offset-4";

export function PressPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  return (
    <MarketingShell locale={locale} path="/press/">
      <Hero
        eyebrow={t("press.hero.eyebrow")}
        title={t("press.hero.title")}
        actions={
          <>
            <PrimaryLink href={PRESS_KIT_HREF}>{t("press.hero.download")}</PrimaryLink>
            <SecondaryLink href={REPO_URL}>{t("press.hero.sourceCode")}</SecondaryLink>
          </>
        }
      >
        <p>{t("press.hero.body")}</p>
        <p>{t("press.hero.quote")}</p>
      </Hero>

      <Section title={t("press.kit.title")}>
        <Bullets items={CONTENTS.map((key) => t(`press.kit.${key}`))} />
      </Section>

      <Section title={t("press.boilerplate.title")}>
        <Prose>
          <p>{t("press.boilerplate.intro")}</p>
          <p>
            <strong>{t("press.boilerplate.oneLineLabel")}</strong> {t("press.boilerplate.oneLine")}
          </p>
          <p>
            <strong>{t("press.boilerplate.shortLabel")}</strong> {t("press.boilerplate.short")}
          </p>
          <p>
            <strong>{t("press.boilerplate.longLabel")}</strong> {t("press.boilerplate.long")}
          </p>
        </Prose>
      </Section>

      <Section title={t("press.shots.title")}>
        <Prose>
          <p>{t("press.shots.intro")}</p>
        </Prose>
        <ul className="mt-8 grid gap-10 sm:grid-cols-2">
          {SHOTS.map(({ key, src, width, height }) => (
            <li key={key} className="space-y-3">
              <Shot src={src} alt={t(`press.shots.${key}.alt`)} width={width} height={height} />
              <p className="text-sm text-muted-foreground">
                <span className="text-foreground">{t(`press.shots.${key}.label`)}</span>{" "}
                {/* The pixel size and the file name are not translated. */}
                {`— ${width}×${height}, ${src.replace("/marketing/", "")}`}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("press.facts.title")}>
        <FactList
          items={FACTS.map((key) => ({
            term: t(`press.facts.${key}.term`),
            detail:
              key === "source" ? (
                <a href={REPO_URL} className={link}>
                  {t("press.facts.source.detail")}
                </a>
              ) : (
                t(`press.facts.${key}.detail`)
              ),
          }))}
        />
      </Section>

      <Section title={t("press.contact.title")} className="pb-24">
        <Prose>
          <p>
            {t.rich("press.contact.body", {
              email: CONTACT_EMAIL,
              mail: (chunks) => (
                <a href={`mailto:${CONTACT_EMAIL}`} className={link}>
                  {chunks}
                </a>
              ),
            })}
          </p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
