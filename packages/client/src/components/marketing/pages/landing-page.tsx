import type { Metadata } from "next";
import Link from "next/link";

import {
  Feature,
  Hero,
  PrimaryLink,
  Prose,
  Questions,
  SecondaryLink,
  Section,
  Shot,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { localizedPath, marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { DONATE_URL, OPENAPI_URL, REPO_URL, SELF_HOSTING_URL } from "@/lib/site-links";

/** Metadata for one locale of this page. `path` stays the English path. */
export const landingMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: { absolute: t("landing.meta.title") },
    description: t("landing.meta.description"),
    path: "/",
  });
};

/** The four ways in. `/signup/` is an app route and stays unprefixed. */
const SURFACES = [
  { href: "/signup/", key: "web", public: false },
  { href: "/extension/", key: "chrome", public: true },
  { href: "/raycast/", key: "raycast", public: true },
  { href: "/mobile/", key: "mobile", public: true },
] as const;

const link = "text-foreground underline underline-offset-4";

/**
 * The landing page, and still the app's front door for a signed-in person:
 * `MarketingShell` sends them on to /track once their session resolves. Inside
 * the native shell none of this paints — see `styles/native.css`.
 */
export function LandingPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  const guide = (chunks: React.ReactNode): React.ReactElement => (
    <a href={SELF_HOSTING_URL} className={link}>
      {chunks}
    </a>
  );
  return (
    <MarketingShell locale={locale} path="/" redirectSignedIn>
      <Hero
        eyebrow={t("landing.hero.eyebrow")}
        title={t("landing.hero.title")}
        actions={
          <>
            <PrimaryLink href={SELF_HOSTING_URL}>{t("landing.hero.hostYourself")}</PrimaryLink>
            <SecondaryLink href="/signup/">{t("landing.hero.useHosted")}</SecondaryLink>
          </>
        }
        shot={
          <Shot
            src="/marketing/web-track.png"
            alt={t("landing.hero.shotAlt")}
            width={1600}
            height={1000}
            priority
          />
        }
      >
        <p>{t("landing.hero.body")}</p>
        <p className="text-base">{t("landing.hero.beta")}</p>
      </Hero>

      <Section title={t("landing.ownership.title")}>
        <Prose>
          <p>{t("landing.ownership.why")}</p>
          <p>{t.rich("landing.ownership.install", { guide })}</p>
          <p className="text-sm">{t("landing.ownership.memory")}</p>
        </Prose>
      </Section>

      <Feature
        title={t("landing.timer.title")}
        shot={
          <Shot
            src="/marketing/popup.png"
            alt={t("landing.timer.shotAlt")}
            width={760}
            height={1200}
            className="mx-auto max-w-xs"
          />
        }
      >
        <p>{t("landing.timer.forgotten")}</p>
        <p>{t("landing.timer.offline")}</p>
      </Feature>

      <Feature
        reverse
        title={t("landing.invoice.title")}
        shot={
          <Shot
            src="/marketing/web-invoice.png"
            alt={t("landing.invoice.shotAlt")}
            width={1600}
            height={1000}
          />
        }
      >
        <p>{t("landing.invoice.rates")}</p>
        <p>{t("landing.invoice.once")}</p>
      </Feature>

      <Feature
        title={t("landing.reports.title")}
        shot={
          <Shot
            src="/marketing/web-reports.png"
            alt={t("landing.reports.shotAlt")}
            width={1600}
            height={1000}
          />
        }
      >
        <p>{t("landing.reports.hours")}</p>
        <p>{t("landing.reports.export")}</p>
      </Feature>

      <Section title={t("landing.surfaces.title")}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SURFACES.map((surface) => (
            <Link
              key={surface.href}
              href={surface.public ? localizedPath(locale, surface.href) : surface.href}
              className="space-y-2 rounded-xl border p-5 hover:bg-accent"
            >
              <p className="font-medium">{t(`landing.surfaces.${surface.key}.name`)}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(`landing.surfaces.${surface.key}.text`)}
              </p>
            </Link>
          ))}
        </div>
      </Section>

      <Section title={t("landing.free.title")}>
        <Prose>
          <p>{t("landing.free.license")}</p>
          <p>
            {t.rich("landing.free.builtBy", {
              repo: (chunks) => (
                <a href={REPO_URL} className={link}>
                  {chunks}
                </a>
              ),
            })}
            {DONATE_URL && (
              <>
                {" "}
                {t.rich("landing.free.donate", {
                  donate: (chunks) => (
                    <a href={DONATE_URL ?? undefined} className={link}>
                      {chunks}
                    </a>
                  ),
                })}
              </>
            )}
          </p>
        </Prose>
      </Section>

      <Section title={t("landing.audience.title")}>
        <Prose>
          <p>{t("landing.audience.body")}</p>
        </Prose>
      </Section>

      <Section title={t("landing.faq.title")}>
        <Questions
          items={[
            { q: t("landing.faq.hosting.q"), a: t("landing.faq.hosting.a") },
            { q: t("landing.faq.requirements.q"), a: t.rich("landing.faq.requirements.a", { guide }) },
            { q: t("landing.faq.import.q"), a: t("landing.faq.import.a") },
            {
              q: t("landing.faq.api.q"),
              a: t.rich("landing.faq.api.a", {
                reference: (chunks) => (
                  <a href={OPENAPI_URL} className={link}>
                    {chunks}
                  </a>
                ),
              }),
            },
            { q: t("landing.faq.shutdown.q"), a: t("landing.faq.shutdown.a") },
          ]}
        />
      </Section>

      <Section title={t("landing.cta.title")} className="pb-24">
        <div className="flex flex-wrap gap-3">
          <PrimaryLink href={SELF_HOSTING_URL}>{t("landing.cta.guide")}</PrimaryLink>
          <SecondaryLink href="/signup/">{t("landing.cta.account")}</SecondaryLink>
        </div>
      </Section>
    </MarketingShell>
  );
}
