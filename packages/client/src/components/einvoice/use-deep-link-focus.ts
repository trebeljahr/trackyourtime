"use client";

import * as React from "react";

import { parseDeepLink } from "./billing-fields";

/**
 * Classes for every `data-field` wrapper a deep link can land on: the ring
 * shows while `useDeepLinkFocus` holds `data-highlight="true"` on it.
 */
export const DEEP_LINK_HIGHLIGHT_CLASS =
  "rounded-md transition-shadow data-[highlight=true]:ring-2 data-[highlight=true]:ring-primary/60 data-[highlight=true]:ring-offset-2 data-[highlight=true]:ring-offset-background";

/** How long the arrived-at row stays highlighted. */
const HIGHLIGHT_MS = 2000;

/** The deep link in the current URL, read once on the client (never during prerender). */
export function useDeepLink(): ReturnType<typeof parseDeepLink> {
  const [link, setLink] = React.useState<ReturnType<typeof parseDeepLink>>({
    field: null,
    billingClientId: null,
    fromInvoiceId: null,
  });
  React.useEffect(() => {
    // Read from `location` rather than `useSearchParams`, which would force a
    // Suspense boundary under the static export (same as settings `?tab=`).
    // After mount, therefore: the prerendered HTML has no query string, and a
    // first client render that read one would disagree with it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLink(parseDeepLink(window.location.search));
  }, []);
  return link;
}

/**
 * Once per mount, after `ready`: find `[data-field="<field>"]` inside `root`,
 * scroll it into view, focus its first control, and highlight it for 2 s.
 * No-op without `?field=`. The field name was already restricted to
 * `[A-Za-z0-9_-]` by `parseDeepLink`, so it is safe inside the selector.
 */
export function useDeepLinkFocus(
  root: React.RefObject<HTMLElement | null>,
  ready: boolean,
  field: string | null,
): void {
  const done = React.useRef(false);

  React.useEffect(() => {
    if (done.current || !ready || field === null || root.current === null) return;
    const target = root.current.querySelector<HTMLElement>(`[data-field="${field}"]`);
    if (!target) return;
    done.current = true;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
    target
      .querySelector<HTMLElement>("input, textarea, select, button, [role=combobox]")
      ?.focus({ preventScroll: true });
    target.dataset.highlight = "true";
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      delete target.dataset.highlight;
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
      delete target.dataset.highlight;
      // Cut short (StrictMode's mount-cleanup-mount, or a dependency change
      // inside the 2 s): let the next run arrive again, or the attribute this
      // cleanup just removed would never come back and the row never lights.
      if (!finished) done.current = false;
    };
  }, [root, ready, field]);
}
