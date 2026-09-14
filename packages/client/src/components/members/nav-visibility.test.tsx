// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { permissionsFor, type WorkspaceSummary } from "@starter/shared";

import { workspaceFor } from "./member-fixtures";

let active: WorkspaceSummary | null = null;
vi.mock("@/components/members/use-active-workspace", () => ({
  useActiveWorkspace: () => ({
    workspace: active,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const { NAV_SECTIONS } = await import("@/components/app-shell");
const { visibleNavSections } = await import("./nav-visibility");
const { WorkspaceTab } = await import("@/components/settings/workspace-tab");

afterEach(cleanup);

const hrefs = (sections: ReturnType<typeof visibleNavSections>): string[] =>
  sections.flatMap((section) => section.items.map((item) => item.href));

describe("nav visibility", () => {
  it("lists Members in the Manage group for everyone", () => {
    const manage = NAV_SECTIONS.find((section) => section.heading === "manage");
    expect(manage?.items.map((item) => item.href)).toContain("/members");
    for (const role of ["owner", "admin", "member"] as const) {
      const permissions = permissionsFor(role, { canViewOthersTime: false, canViewOthersMoney: false });
      expect(hrefs(visibleNavSections(NAV_SECTIONS, permissions))).toContain("/members");
    }
  });

  it("hides Invoices when the workspace does not grant invoices", () => {
    const member = permissionsFor("member", { canViewOthersTime: true, canViewOthersMoney: true });
    expect(hrefs(visibleNavSections(NAV_SECTIONS, member))).not.toContain("/invoices");
    const closedAdmin = permissionsFor("admin", { canViewOthersTime: true, canViewOthersMoney: false });
    expect(hrefs(visibleNavSections(NAV_SECTIONS, closedAdmin))).not.toContain("/invoices");
  });

  it("shows Invoices to an owner, and while permissions are still unknown", () => {
    const owner = permissionsFor("owner", { canViewOthersTime: false, canViewOthersMoney: false });
    expect(hrefs(visibleNavSections(NAV_SECTIONS, owner))).toContain("/invoices");
    expect(hrefs(visibleNavSections(NAV_SECTIONS, null))).toContain("/invoices");
  });
});

describe("WorkspaceTab", () => {
  it("names the workspace and role and links to /members", () => {
    active = workspaceFor("admin", { name: "Studio", memberCount: 4 });
    render(<WorkspaceTab />);
    expect(screen.getByTestId("workspace-tab-name")).toHaveTextContent("Studio");
    expect(screen.getByTestId("workspace-tab-role")).toHaveTextContent("Admin");
    expect(screen.getByTestId("workspace-tab-count")).toHaveTextContent("4 members");
    const link = screen.getByTestId("workspace-tab-members-link");
    expect(link.getAttribute("href")).toMatch(/^\/members\/?$/);
    expect(link).toHaveTextContent("Manage members");
  });

  it("offers a plain member a view, not management", () => {
    active = workspaceFor("member");
    render(<WorkspaceTab />);
    expect(screen.getByTestId("workspace-tab-members-link")).toHaveTextContent("View members");
  });
});
