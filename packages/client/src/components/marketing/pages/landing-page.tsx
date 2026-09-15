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
import { ShellEntryRedirect } from "@/components/marketing/shell-entry-redirect";
import { localizedPath, marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { API_REFERENCE_URL, DONATE_URL, MCP_DOCS_URL, REPO_URL, SELF_HOSTING_URL } from "@/lib/site-links";

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
 * The landing page. A signed-in visitor stays on it; the header links them
 * into the app. Inside the native and desktop shells `ShellEntryRedirect`
 * moves on to /app/track, and on native none of this paints — see
 * `styles/native.css`.
 */
export function LandingPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  const guide = (chunks: React.ReactNode): React.ReactElement => (
    <a href={SELF_HOSTING_URL} className={link}>
      {chunks}
    </a>
  );
  return (
    <MarketingShell locale={locale} path="/">
      <ShellEntryRedirect />
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
        <p className="text-base">{t("landing.hero.free")}</p>
      </Hero>

      <Feature
        title={t("landing.everywhere.title")}
        shot={
          <Shot
            src="/marketing/popup.png"
            alt={t("landing.everywhere.shotAlt")}
            width={760}
            height={1200}
            className="mx-auto max-w-xs"
          />
        }
      >
        <p>{t("landing.everywhere.forgotten")}</p>
        <p>{t("landing.everywhere.offline")}</p>
      </Feature>

      <section className="mx-auto max-w-6xl px-6 pb-14">
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
      </section>

      <Section title={t("landing.routine.title")}>
        <Prose>
          <p>{t("landing.routine.repeat")}</p>
          <p>{t("landing.routine.guard")}</p>
          <p>{t("landing.routine.suggestions")}</p>
        </Prose>
      </Section>

      <Feature
        reverse
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
        <p>{t("landing.reports.structure")}</p>
        <p>{t("landing.reports.hours")}</p>
        <p>{t("landing.reports.edit")}</p>
      </Feature>

      <Feature
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

      <Section title={t("landing.team.title")}>
        <Prose>
          <p>{t("landing.team.invite")}</p>
          <p>{t("landing.team.limits")}</p>
        </Prose>
      </Section>

      <Section title={t("landing.data.title")}>
        <Prose>
          <p>{t("landing.data.import")}</p>
          <p>{t("landing.data.export")}</p>
          <p>
            {t.rich("landing.data.connect", {
              reference: (chunks) => (
                <a href={API_REFERENCE_URL} className={link}>
                  {chunks}
                </a>
              ),
              mcp: (chunks) => (
                <a href={MCP_DOCS_URL} className={link}>
                  {chunks}
                </a>
              ),
            })}
          </p>
        </Prose>
      </Section>

      <Section title={t("landing.selfHost.title")}>
        <Prose>
          <p>{t("landing.selfHost.why")}</p>
          <p>{t.rich("landing.selfHost.install", { guide })}</p>
          <p>{t("landing.selfHost.clients")}</p>
          <p className="text-sm">{t("landing.selfHost.limits")}</p>
        </Prose>
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

      <Section title={t("landing.faq.title")}>
        <Questions
          items={[
            { q: t("landing.faq.hosting.q"), a: t("landing.faq.hosting.a") },
            { q: t("landing.faq.requirements.q"), a: t.rich("landing.faq.requirements.a", { guide }) },
            { q: t("landing.faq.clients.q"), a: t("landing.faq.clients.a") },
            { q: t("landing.faq.stores.q"), a: t("landing.faq.stores.a") },
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
