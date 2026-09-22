"use client";

import * as React from "react";
import type { WorkspacePermissions } from "@starter/shared";

import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useDesktopActivityAvailable } from "@/components/activity/use-desktop-activity";
import type { NavItem } from "@/lib/nav";

type Section = { heading: string | null; items: NavItem[] };

/**
 * The nav without the destinations the viewer's role cannot use.
 *
 * Purely cosmetic — /invoices refuses on the server whatever the sidebar
 * shows. While permissions are unknown (loading, or a cold offline launch)
 * everything stays: hiding first and revealing later would make a solo
 * owner's Invoices item flicker on every load, and the page itself is where
 * a refusal is explained.
 */
export const visibleNavSections = <S extends Section>(
  sections: readonly S[],
  permissions: WorkspacePermissions | null,
  /**
   * Which shell-only items may show: `electron` when this is the desktop app
   * AND it reports the item's feature available. Unlike permissions, unknown
   * here means hidden — the web must never draw a desktop destination, not
   * even for a frame.
   */
  shells: { electron: boolean } = { electron: false },
): S[] =>
  sections.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        (item.shell === undefined || shells[item.shell]) &&
        (permissions === null || item.requires === undefined || permissions[item.requires]),
    ),
  }));

export const useVisibleNavSections = <S extends Section>(sections: readonly S[]): S[] => {
  const permissions = useActiveWorkspace().workspace?.permissions ?? null;
  const electron = useDesktopActivityAvailable();
  return React.useMemo(
    () => visibleNavSections(sections, permissions, { electron }),
    [sections, permissions, electron],
  );
};
