"use client";

import * as React from "react";

import type { ClientLocale } from "@/i18n/config";
import {
  commitTargetLocale,
  FixedLocaleContext,
  releaseLocaleGate,
  useLocale,
} from "@/i18n/locale-store";

/**
 * Switches the app from the prerendered English to the reader's language, and
 * lifts the pre-paint gate once that render has committed.
 *
 * Mounted once, in app/layout.tsx, around everything that follows the
 * preference. The order of events on a German cold load:
 *
 *  1. LOCALE_SCRIPT sets `data-locale-pending`; the gate below is invisible.
 *  2. React hydrates. Every `useLocale()` answers "en" (server snapshot), so
 *     the tree matches the English HTML and nothing is reported.
 *  3. This layout effect runs after that commit and switches the store to
 *     "de". Subscribers re-render synchronously — an update scheduled in a
 *     layout effect is flushed before the browser paints.
 *  4. The effect below sees `locale` change and removes the attribute, in the
 *     same pre-paint flush. The first visible frame is German.
 *
 * `display: contents` keeps the wrapper out of layout: no box, no flex or grid
 * item, so `body > *` and `min-h-screen` children behave exactly as before.
 */
export function LocaleRoot({ children }: { children: React.ReactNode }): React.JSX.Element {
  const locale = useLocale();

  React.useLayoutEffect(() => {
    commitTargetLocale();
  }, []);

  React.useLayoutEffect(() => {
    releaseLocaleGate();
  }, [locale]);

  return (
    <div data-locale-gate="" style={{ display: "contents" }}>
      {children}
    </div>
  );
}

/**
 * Pins a subtree to one locale, whatever the reader's preference.
 *
 * For the public pages, which exist once per language (`/` and `/de/`) and are
 * rendered at build time in that language — they must hydrate and stay in it.
 * The `lang` attribute scopes the language for screen readers and search
 * engines even where <html lang> says otherwise, and `data-locale-fixed`
 * exempts the subtree from the pre-paint gate, which it does not need.
 *
 * The wrapper is a real box, never `display: contents`, because it is the
 * first DOM node of every public page. On a client-side navigation Next's
 * layout router scrolls to that node, and it skips any node whose rect is all
 * zeros — a `contents` box has no rect, so the new page kept the previous
 * page's scroll position. Callers style the box through `className`.
 */
export function FixedLocale({
  locale,
  className,
  children,
  ...rest
}: {
  locale: ClientLocale;
  className?: string;
  children: React.ReactNode;
} & { [data: `data-${string}`]: string | undefined }): React.JSX.Element {
  return (
    <FixedLocaleContext.Provider value={locale}>
      <div {...rest} data-locale-fixed="" lang={locale} className={className}>
        {children}
      </div>
    </FixedLocaleContext.Provider>
  );
}
