import type { LucideIcon } from "lucide-react";
import type { WorkspacePermissions } from "@starter/shared";

/**
 * The shape of one destination and the rule for when it is the current one.
 *
 * Lives here rather than in components/app-shell.tsx so the native tab bar
 * can share the rule without importing the shell that renders it — the shell
 * renders the tab bar, and a cycle between the two would resolve differently
 * depending on which module the bundler reached first.
 */
export type NavItem = {
  href: string;
  label: string;
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
