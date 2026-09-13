/**
 * Locale constants with no React and no browser APIs, so server components
 * (the prerendered public pages, app/layout.tsx) can import them. Anything
 * stateful lives in locale-store.ts, which is client-only.
 */
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "@starter/shared";

export { SUPPORTED_LOCALES, type Locale };

/**
 * A locale the client can render: the shipped ones plus the pseudo-locale,
 * which exists only outside production builds and never reaches the server.
 */
export type ClientLocale = Locale | "pseudo";

/** The stored preference. Must match LOCALE_SCRIPT in app/pre-paint.ts. */
export const LOCALE_STORAGE_KEY = "tracktime.locale";

/** Dev-only pseudo-locale switch. Must match LOCALE_SCRIPT in app/pre-paint.ts. */
export const LOCALE_OVERRIDE_STORAGE_KEY = "tracktime.locale.override";

/** Set on <html> by LOCALE_SCRIPT while the rendered language is still wrong. */
export const LOCALE_PENDING_ATTRIBUTE = "data-locale-pending";

/** The language every static HTML file outside /de/ is prerendered in. */
export const PRERENDER_LOCALE: Locale = DEFAULT_LOCALE;

/** False in `next build` output, so the pseudo-locale cannot ship. */
export const PSEUDO_LOCALE_ENABLED = process.env.NODE_ENV !== "production";

/** The `lang` attribute for a client locale. "en-XA" is the conventional pseudo tag. */
export const htmlLang = (locale: ClientLocale): string => (locale === "pseudo" ? "en-XA" : locale);
