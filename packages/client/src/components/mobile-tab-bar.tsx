"use client";

import * as React from "react";
import Link from "next/link";
import { BarChart3, Menu, Timer, type LucideIcon } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { isActiveRoute } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The native shell's bottom tab bar.
 *
 * THREE tabs, and the third is not a screen: More opens the app's EXISTING
 * nav drawer with the EXISTING `NAV_SECTIONS`. There is deliberately no
 * second list of destinations to keep in step — a screen added to the web
 * sidebar appears on the phone the same day, one level down, instead of
 * silently not existing there.
 *
 * It is rendered unconditionally and hidden with `hidden` (display: none),
 * which styles/native.css undoes under `html.cap`. Returning `null` on
 * `!isNative()` instead would be a hydration mismatch: `output: "export"`
 * prerenders every page in Node, where `window.Capacitor` cannot exist, so
 * the served HTML has the bar and the native hydration would not.
 */

type Tab = {
  /** Test id suffix and message key under `shell.tabBar`, resolved at render. */
  key: "track" | "reports" | "more";
  icon: LucideIcon;
  /** Where the tab goes, or `null` for the one that opens the drawer. */
  href: string | null;
  /** Prefixes that light the tab up, beyond `href` itself. */
  match?: string[];
};

const TABS: Tab[] = [
  { key: "track", icon: Timer, href: "/app/track" },
  {
    key: "reports",
    icon: BarChart3,
    // `isActiveRoute` lights child paths too, so the retired /reports/summary,
    // /detailed and /weekly redirects keep this tab lit for the frame before
    // they land — no `match` needed.
    href: "/app/reports",
  },
  { key: "more", icon: Menu, href: null },
];

const isTabActive = (pathname: string, tab: Tab): boolean =>
  tab.href !== null &&
  isActiveRoute(pathname, { href: tab.href, match: tab.match });

export type MobileTabBarProps = {
  pathname: string;
  /** Opens the drawer the hamburger already opens. */
  onOpenMore: () => void;
  /** True while that drawer is open, so More reads as the current surface. */
  moreOpen: boolean;
};

export function MobileTabBar({
  pathname,
  onOpenMore,
  moreOpen,
}: MobileTabBarProps): React.JSX.Element {
  // More is lit whenever the drawer is open, and also whenever the route is
  // one only the drawer can reach — otherwise a phone on /settings shows no
  // active tab at all and the bar looks broken.
  const t = useT("shell");
  const onATab = TABS.some((tab) => isTabActive(pathname, tab));

  const isActive = (tab: Tab): boolean => {
    // Exactly one cell is ever lit. While the drawer is open it is More,
    // even standing on /track: the drawer is the surface in front of the
    // user, and two lit tabs read as a rendering bug.
    if (moreOpen) return tab.href === null;
    if (tab.href === null) return !onATab;
    return isTabActive(pathname, tab);
  };

  return (
    <nav
      // `hidden` is the whole web story: display:none everywhere, undone only
      // by `html.cap [data-testid="mobile-tab-bar"]` in styles/native.css.
      className="hidden fixed inset-x-0 bottom-0 z-40 items-stretch border-t border-border bg-background/95 backdrop-blur"
      data-testid="mobile-tab-bar"
      aria-label={t("tabBar.label")}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isActive(tab);
        const content = (
          <>
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            <span className="text-[0.6875rem] leading-none">{t(`tabBar.${tab.key}`)}</span>
          </>
        );
        const className = cn(
          "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-xs transition-colors",
          active
            ? "font-medium text-foreground"
            : "text-muted-foreground"
        );

        if (tab.href === null) {
          return (
            <button
              key={tab.key}
              type="button"
              onClick={onOpenMore}
              className={className}
              aria-expanded={moreOpen}
              data-testid={`tab-${tab.key}`}
              data-active={active ? "true" : undefined}
            >
              {content}
            </button>
          );
        }

        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={className}
            aria-current={active ? "page" : undefined}
            data-testid={`tab-${tab.key}`}
            data-active={active ? "true" : undefined}
          >
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
