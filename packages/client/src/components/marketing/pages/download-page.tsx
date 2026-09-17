import type { Metadata } from "next";

import { FactList, Hero, Prose, SecondaryLink, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, marketingT, type Locale } from "@/i18n/marketing";
import { DESKTOP_DOCS_URL, DESKTOP_DOWNLOADS, type DesktopDownloadId } from "@/lib/site-links";

/** Metadata for one locale of this page. `path` stays the English path. */
export const downloadMetadata = (locale: Locale): Metadata => {
  const t = marketingT(locale);
  return marketingMetadata(locale, {
    title: t("download.meta.title"),
    description: t("download.meta.description"),
    path: "/download/",
  });
};

/**
 * The default "start or stop the timer" shortcut (DEFAULT_DESKTOP_SHORTCUTS),
 * spelled the way Settings → Desktop shows it in each language
 * (`desktop.shortcuts.keys` in the settings catalog).
 */
const DEFAULT_SHORTCUT: Record<Locale, { mac: string; other: string }> = {
  en: { mac: "⌥⇧⌘Space", other: "Ctrl+Alt+Shift+Space" },
  de: { mac: "⌥⇧⌘Leertaste", other: "Strg+Alt+Umschalt+Leertaste" },
};

/** Direct downloads first, then the stores and package managers. */
const CHANNELS: readonly DesktopDownloadId[] = [
  "mac",
  "windows",
  "linux",
  "homebrew",
  "macAppStore",
  "microsoftStore",
  "flathub",
  "snapStore",
];

const link = "text-foreground underline underline-offset-4";

/**
 * /download/: the desktop app, and where each build can be had. Every channel
 * reads its address from `DESKTOP_DOWNLOADS`; `null` renders "not released
 * yet", so the page never links a file or a listing that does not exist.
 */
export function DownloadPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  const docs = (chunks: React.ReactNode): React.ReactElement => (
    <a href={DESKTOP_DOCS_URL} hrefLang="en" className={link}>
      {chunks}
    </a>
  );
  const released = CHANNELS.some((id) => DESKTOP_DOWNLOADS[id].url !== null);
  return (
    <MarketingShell locale={locale} path="/download/">
      <Hero
        eyebrow={t("download.hero.eyebrow")}
        title={t("download.hero.title")}
        actions={
          <>
            <a
              href="#downloads"
              className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("download.hero.downloads")}
            </a>
            <SecondaryLink href="/signup/">{t("download.hero.createAccount")}</SecondaryLink>
          </>
        }
      >
        <p>{t("download.hero.body", DEFAULT_SHORTCUT[locale])}</p>
      </Hero>

      <Section title={t("download.tray.title")}>
        <Prose>
          <p>{t("download.tray.body")}</p>
          <p>{t("download.tray.close")}</p>
        </Prose>
      </Section>

      <Section title={t("download.away.title")}>
        <Prose>
          <p>{t("download.away.body")}</p>
        </Prose>
      </Section>

      <Section title={t("download.shortcuts.title")}>
        <Prose>
          <p>{t("download.shortcuts.body")}</p>
        </Prose>
      </Section>

      <Section title={t("download.offline.title")}>
        <Prose>
          <p>{t("download.offline.body")}</p>
          <p>{t("download.offline.signIn")}</p>
        </Prose>
      </Section>

      <Section id="downloads" title={t("download.channels.title")} className="pb-24">
        <div className="space-y-8">
          <Prose>
            <p>{released ? t.rich("download.channels.intro", { docs }) : t.rich("download.channels.notYet", { docs })}</p>
          </Prose>
          <FactList
            items={CHANNELS.map((id) => {
              const { url } = DESKTOP_DOWNLOADS[id];
              return {
                term: t(`download.channels.${id}.name`),
                detail: url ? (
                  <a href={url} className={link} data-testid={`download-${id}`}>
                    {t(`download.channels.${id}.get`)}
                  </a>
                ) : (
                  <span data-testid={`download-pending-${id}`}>{t(`download.channels.${id}.pending`)}</span>
                ),
              };
            })}
          />
        </div>
      </Section>
    </MarketingShell>
  );
}
