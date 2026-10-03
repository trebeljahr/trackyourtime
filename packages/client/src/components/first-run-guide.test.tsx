// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceSummary } from "@starter/shared";

const state = vi.hoisted(() => ({
  userId: "user-a",
  server: "https://server.example",
  workspace: null as WorkspaceSummary | null,
  projects: [] as Array<{ id: string; hourlyRate: number | null }>,
  clients: [] as Array<{ id: string }>,
  profile: null as Record<string, unknown> | null,
  invoices: { invoices: [] as Array<{ id: string }> },
  defaultHourlyRate: 0,
  memberHourlyRate: null as number | null,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: state.userId } }) }));
vi.mock("@/components/members/use-active-workspace", () => ({
  useActiveWorkspace: () => ({ workspace: state.workspace }),
}));
vi.mock("@/hooks/use-api-origin", () => ({ useApiOrigin: () => ({ ready: true }) }));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => state.server }));
vi.mock("@/mobile/preferences-storage", () => ({
  shouldUseNativeStorage: () => false,
  preferencesStorage: () => { throw new Error("web must not use native preferences"); },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    settings: {
      get: { useQuery: () => ({ data: { defaultHourlyRate: state.defaultHourlyRate, memberHourlyRate: state.memberHourlyRate } }) },
      businessProfile: { useQuery: () => ({ data: state.profile }) },
    },
    projects: { list: { useQuery: () => ({ data: state.projects }) } },
    clients: { list: { useQuery: () => ({ data: state.clients }) } },
    invoices: { list: { useQuery: () => ({ data: state.invoices }) } },
  },
}));

const { FirstRunGuide, firstRunStorageKey } = await import("./first-run-guide");
const { DocsLink } = await import("./app-shell");
const { DOCS_URL } = await import("@/lib/site-links");

const permissions = (viewOthersMoney: boolean, invoices: boolean) => ({
  inviteMembers: false,
  inviteAdmins: false,
  changeRoles: false,
  editTimeVisibility: false,
  editMoneyVisibility: false,
  removeMembers: false,
  transferOwnership: false,
  invoices,
  viewOthersTime: viewOthersMoney,
  viewOthersMoney,
});

const ownerWorkspace = (): WorkspaceSummary => ({
  id: "workspace-a",
  name: "Personal",
  role: "owner",
  memberCount: 1,
  isDefault: true,
  permissions: permissions(true, true),
});

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  state.userId = "user-a";
  state.server = "https://server.example";
  state.workspace = ownerWorkspace();
  state.projects = [];
  state.clients = [];
  state.profile = null;
  state.invoices = { invoices: [] };
  state.defaultHourlyRate = 0;
  state.memberHourlyRate = null;
});

afterEach(cleanup);

describe("FirstRunGuide", () => {
  it("shows both paths and derives checked steps from workspace data", async () => {
    state.projects = [{ id: "project-1", hourlyRate: 80 }];
    state.clients = [{ id: "client-1" }];
    state.profile = {
      workspaceId: "workspace-a",
      legalName: "Studio",
      addressLines: ["1 Main Street"],
      city: "Berlin",
      country: "DE",
      postalCode: "10115",
    };
    state.invoices = { invoices: [{ id: "invoice-1" }] };

    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);

    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.getByText("Just track time")).toBeInTheDocument();
    expect(screen.getByText("Bill clients")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-select-tracking")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-select-billing")).toBeInTheDocument();
    expect(screen.getByText("Start your first timer")).toHaveAttribute("data-complete", "false");
    expect(screen.getByText("Add a project (optional)")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("Add a client and project")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("Set a project rate")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("Add your business details")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("Create your first invoice")).toHaveAttribute("data-complete", "true");
  });

  it("keeps an enrolled guide after the first entry and marks that step complete", async () => {
    const { rerender, unmount } = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    rerender(<FirstRunGuide hasAnyEntry canEnroll={false} />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.getByText("Start your first timer")).toHaveAttribute("data-complete", "true");
    unmount();
    render(<FirstRunGuide hasAnyEntry canEnroll={false} />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.getByText("Start your first timer")).toHaveAttribute("data-complete", "true");
  });

  it("counts an own-member rate with no project or workspace rate", async () => {
    state.memberHourlyRate = 95;
    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.getByText("Set a project rate")).toHaveAttribute("data-complete", "true");
  });
  it("does not count a workspace rate overridden by a zero member rate", async () => {
    state.defaultHourlyRate = 95; state.memberHourlyRate = 0;
    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.getByText("Set a project rate")).toHaveAttribute("data-complete", "false");
  });

  it("counts the workspace default rate when no project has an override", async () => {
    state.defaultHourlyRate = 45;
    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.getByText("Set a project rate")).toHaveAttribute("data-complete", "true");
  });

  it("lets a tracking-only user complete the guide without billing setup", async () => {
    const { rerender } = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    fireEvent.click(await screen.findByTestId("first-run-select-tracking"));
    expect(screen.queryByTestId("first-run-billing")).not.toBeInTheDocument();

    rerender(<FirstRunGuide hasAnyEntry canEnroll={false} />);
    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(firstRunStorageKey("https://server.example", "user-a", "workspace-a"))).toBe("completed");
  });

  it("does not write completion into a new identity during a scope switch", async () => {
    const { rerender } = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();

    state.projects = [{ id: "project-1", hourlyRate: 80 }];
    state.clients = [{ id: "client-1" }];
    state.profile = {
      workspaceId: "workspace-a",
      legalName: "Studio",
      addressLines: ["1 Main Street"],
      city: "Berlin",
      country: "DE",
      postalCode: "10115",
    };
    state.invoices = { invoices: [{ id: "invoice-1" }] };
    state.userId = "user-b";
    rerender(<FirstRunGuide hasAnyEntry canEnroll={false} />);

    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(firstRunStorageKey("https://server.example", "user-b", "workspace-a"))).toBeNull();
  });

  it("stays out of returning workspaces and shared workspaces", () => {
    const { rerender } = render(<FirstRunGuide hasAnyEntry canEnroll={false} />);
    expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument();

    state.workspace = {
      ...ownerWorkspace(),
      memberCount: 2,
      permissions: permissions(false, false),
    };
    rerender(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument();
  });

  it("hides billing guidance without owner/admin money and invoice access", async () => {
    state.workspace = {
      ...ownerWorkspace(),
      role: "member",
      permissions: permissions(false, false),
    };

    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    expect(screen.queryByTestId("first-run-billing")).not.toBeInTheDocument();
    expect(screen.getByText("Just track time")).toBeInTheDocument();
  });

  it("persists dismissal across remounts and scopes it by server, user and workspace", async () => {
    const { unmount } = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    fireEvent.click(await screen.findByTestId("first-run-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(firstRunStorageKey("https://server.example", "user-a", "workspace-a"))).toBe("dismissed");

    unmount();
    const sameIdentity = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument());
    sameIdentity.unmount();

    state.userId = "user-b";
    const otherUser = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    otherUser.unmount();

    state.userId = "user-a";
    state.workspace = { ...ownerWorkspace(), id: "workspace-b" };
    const otherWorkspace = render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
    otherWorkspace.unmount();

    state.workspace = ownerWorkspace();
    state.server = "https://other.example";
    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    expect(await screen.findByTestId("first-run-guide")).toBeInTheDocument();
  });

  it("keeps working when local storage writes fail", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    render(<FirstRunGuide hasAnyEntry={false} canEnroll />);
    fireEvent.click(await screen.findByTestId("first-run-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).not.toBeInTheDocument());
  });
});

describe("DocsLink", () => {
  it("uses the site docs URL in a plain anchor", () => {
    render(<DocsLink />);
    const link = screen.getByTestId("app-docs-link");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", DOCS_URL);
    expect(link).toHaveTextContent("Help and documentation");
  });
});
