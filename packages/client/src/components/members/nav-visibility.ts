"use client";

import * as React from "react";
import type { WorkspacePermissions } from "@starter/shared";

import { useActiveWorkspace } from "@/components/members/use-active-workspace";
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
): S[] => {
  if (permissions === null) return [...sections];
  return sections.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.requires === undefined || permissions[item.requires],
    ),
  }));
};

export const useVisibleNavSections = <S extends Section>(sections: readonly S[]): S[] => {
  const permissions = useActiveWorkspace().workspace?.permissions ?? null;
  return React.useMemo(() => visibleNavSections(sections, permissions), [sections, permissions]);
};
