import * as React from "react";
import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { AccountLinks } from "@/components/marketing/account-links";
import { FixedLocale } from "@/i18n/locale-root";
import { localizedPath, marketingT, MARKETING_LOCALES, type Locale } from "@/i18n/marketing";
import { API_DOCS_URL, DOCS_URL, REPO_URL } from "@/lib/site-links";

const NAV = [
  { href: "/extension/", label: "chrome" },
  { href: "/raycast/", label: "raycast" },
  { href: "/mobile/", label: "mobile" },
  { href: "/download/", label: "desktop" },
] as const;

/**
 * The chrome around every public page: a header with the client pages
 * and the docs, and a footer with the legal and developer links.
 *
 * The docs links are plain `<a>`: /docs/ is a separate Docusaurus build copied
 * into the export, not a Next route, so `<Link>` would try a client-side
 * navigation to a page the router does not have. The docs are English only.
 *
 * `data-marketing` is what `styles/native.css` hides inside the Capacitor
 * shell. The native app opens on `/`, and the first frame it paints must not be
 * a landing page for the app the person is already holding.
 */
export function MarketingShell({
  children,
  locale = "en",
  path,
}: {
  children: React.ReactNode;
  /** The language this copy of the page is built in. */
  locale?: Locale;
  /** The page's ENGLISH path ("/privacy/"), for the language switch. */
  path: string;
}): React.ReactElement {
  const t = marketingT(locale);
  const href = (target: string): string => localizedPath(locale, target);
  return (
    <FixedLocale locale={locale} data-marketing="" className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
          <Link href={href("/")} className="inline-flex items-center gap-2" data-testid="marketing-home">
            <BrandMark label={null} className="size-7" />
            <span className="text-xl font-semibold tracking-tight">
              Track Your <span className="text-brand">Time</span>
            </span>
          </Link>
          <nav className="order-3 flex w-full gap-5 text-sm text-muted-foreground sm:order-none sm:w-auto">
            {NAV.map((item) => (
              <Link key={item.href} href={href(item.href)} className="hover:text-foreground">
                {t(`shell.nav.${item.label}`)}
              </Link>
            ))}
            <a href={DOCS_URL} hrefLang="en" className="hover:text-foreground" data-testid="marketing-docs">
              {t("shell.nav.docs")}
            </a>
          </nav>
          <AccountLinks
            logIn={t("shell.logIn")}
            createAccount={t("shell.createAccount")}
            openApp={t("shell.openApp")}
          />
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t text-sm text-muted-foreground">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 sm:grid-cols-3">
          <div className="space-y-2">
            <p className="font-medium text-foreground">Track Your Time</p>
            <p>{t("shell.footer.tagline")}</p>
          </div>
          <ul className="space-y-2">
            <li><Link href={href("/extension/")} className="hover:text-foreground">{t("shell.footer.chromeExtension")}</Link></li>
            <li><Link href={href("/raycast/")} className="hover:text-foreground">{t("shell.footer.raycastExtension")}</Link></li>
            <li><Link href={href("/mobile/")} className="hover:text-foreground">{t("shell.footer.mobile")}</Link></li>
            <li><Link href={href("/download/")} className="hover:text-foreground">{t("shell.footer.desktop")}</Link></li>
            <li><Link href={href("/invoice-generator/")} className="hover:text-foreground">{t("shell.footer.invoiceGenerator")}</Link></li>
          </ul>
          <ul className="space-y-2">
            <li><a href={REPO_URL} className="hover:text-foreground">{t("shell.footer.sourceCode")}</a></li>
            <li><a href={DOCS_URL} hrefLang="en" className="hover:text-foreground">{t("shell.footer.docs")}</a></li>
            <li><a href={API_DOCS_URL} hrefLang="en" className="hover:text-foreground">{t("shell.footer.apiDocs")}</a></li>
            <li><Link href={href("/privacy/")} className="hover:text-foreground">{t("shell.footer.privacy")}</Link></li>
            <li><Link href={href("/support/")} className="hover:text-foreground">{t("shell.footer.support")}</Link></li>
          </ul>
          <LanguageSwitch locale={locale} path={path} />
        </div>
      </footer>
    </FixedLocale>
  );
}

/**
 * Links to this page in every other language, each labelled in its own
 * language ("Deutsch" on the English page, "English" on the German one) and
 * marked with `hreflang` and `lang`.
 */
function LanguageSwitch({ locale, path }: { locale: Locale; path: string }): React.ReactElement {
  const t = marketingT(locale);
  const label: Record<Locale, string> = {
    en: t("languageSwitch.toEn"),
    de: t("languageSwitch.toDe"),
  };
  return (
    <nav aria-label={t("languageSwitch.label")} className="sm:col-span-3" data-testid="language-switch">
      <ul className="flex gap-4">
        {MARKETING_LOCALES.filter((each) => each !== locale).map((each) => (
          <li key={each}>
            <Link
              href={localizedPath(each, path)}
              hrefLang={each}
              lang={each}
              className="hover:text-foreground"
              data-testid={`language-switch-${each}`}
            >
              {label[each]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
