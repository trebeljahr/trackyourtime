import * as React from "react";
import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { SignedInRedirect } from "@/components/marketing/signed-in-redirect";
import { FixedLocale } from "@/i18n/locale-root";
import { localizedPath, marketingT, MARKETING_LOCALES, type Locale } from "@/i18n/marketing";
import { OPENAPI_URL, REPO_URL } from "@/lib/site-links";

const NAV = [
  { href: "/extension/", label: "chrome" },
  { href: "/raycast/", label: "raycast" },
  { href: "/mobile/", label: "mobile" },
] as const;

/**
 * The chrome around every public page: a header with the three client pages,
 * and a footer with the legal and developer links.
 *
 * `data-marketing` is what `styles/native.css` hides inside the Capacitor
 * shell. The native app opens on `/`, and the first frame it paints must not be
 * a landing page for the app the person is already holding.
 */
export function MarketingShell({
  children,
  locale = "en",
  path,
  redirectSignedIn = false,
}: {
  children: React.ReactNode;
  /** The language this copy of the page is built in. */
  locale?: Locale;
  /** The page's ENGLISH path ("/privacy/"), for the language switch. */
  path: string;
  /** Send a signed-in visitor to /track. Only the landing page does this. */
  redirectSignedIn?: boolean;
}): React.ReactElement {
  const t = marketingT(locale);
  const href = (target: string): string => localizedPath(locale, target);
  return (
    <FixedLocale locale={locale}>
    <div data-marketing className="flex min-h-screen flex-col">
      {redirectSignedIn && <SignedInRedirect />}
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
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <Link href="/login/" className="text-muted-foreground hover:text-foreground">
              {t("shell.logIn")}
            </Link>
            <Link
              href="/signup/"
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("shell.createAccount")}
            </Link>
          </div>
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
          </ul>
          <ul className="space-y-2">
            <li><a href={REPO_URL} className="hover:text-foreground">{t("shell.footer.sourceCode")}</a></li>
            <li><a href={OPENAPI_URL} className="hover:text-foreground">{t("shell.footer.apiSpec")}</a></li>
            <li><Link href={href("/privacy/")} className="hover:text-foreground">{t("shell.footer.privacy")}</Link></li>
            <li><Link href={href("/support/")} className="hover:text-foreground">{t("shell.footer.support")}</Link></li>
          </ul>
          <LanguageSwitch locale={locale} path={path} />
        </div>
      </footer>
    </div>
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
