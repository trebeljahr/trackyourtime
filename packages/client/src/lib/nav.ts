import type { LucideIcon } from "lucide-react";
import type { WorkspacePermissions } from "@starter/shared";

import type { shell } from "@/i18n/messages/en/shell";

/** A destination's id: its message key under `shell.nav.items` and its test id. */
export type NavItemId = keyof (typeof shell)["nav"]["items"];

/**
 * The shape of one destination and the rule for when it is the current one.
 *
 * Lives here rather than in components/app-shell.tsx so the native tab bar
 * can share the rule without importing the shell that renders it — the shell
 * renders the tab bar, and a cycle between the two would resolve differently
 * depending on which module the bundler reached first.
 *
 * Carries an id, never label text: the list is a module-level constant,
 * evaluated before the locale is known, so the label is resolved with `t` at
 * render time.
 */
export type NavItem = {
  id: NavItemId;
  href: string;
  icon: LucideIcon;
  /** Extra path prefixes that should light this item up. */
  match?: string[];
  /**
   * Hidden unless the active workspace grants this permission. Cosmetic only:
   * the screen behind it is refused on the server either way.
   */
  requires?: keyof WorkspacePermissions;
};

/** Active when the path is the item's route or a child of it. */
export const isActiveRoute = (
  pathname: string,
  item: Pick<NavItem, "href" | "match">,
): boolean => {
  const candidates = [item.href, ...(item.match ?? [])];
  return candidates.some(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );
};
