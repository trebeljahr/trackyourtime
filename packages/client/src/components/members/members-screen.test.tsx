// @vitest-environment jsdom
/**
 * The Members screen wired to (mocked) tRPC.
 *
 * What these pin beyond the table's own tests: destructive actions go through
 * a confirmation and send nothing until it is accepted; nothing names a
 * workspace id (the server resolves it); a plain member never asks for — and
 * so can never be shown — the invitation links; and leaving points the device
 * at the workspace the server picked and reloads into it.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  type PendingInvitation,
  type WorkspaceMemberRow,
  type WorkspaceSummary,
} from "@starter/shared";

import { memberRow, teamRows, workspaceFor } from "./member-fixtures";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

const state: {
  workspaces: WorkspaceSummary[];
  members: WorkspaceMemberRow[];
  invitations: PendingInvitation[];
} = { workspaces: [], members: [], invitations: [] };

const invitationsListQuery = vi.fn();
const calls = {
  updateRate: vi.fn(async (_input: unknown) => ({})),
  updateRole: vi.fn(async (_input: unknown) => ({})),
  updateVisibility: vi.fn(async (_input: unknown) => ({})),
  remove: vi.fn(async (_input: unknown) => ({ ok: true })),
  transferOwnership: vi.fn(async (_input: unknown) => ({ ok: true })),
  leave: vi.fn(async (_input: unknown) => ({ nextWorkspaceId: "ws-personal" })),
  create: vi.fn(async (_input: unknown) => ({})),
  createWorkspace: vi.fn(async (_input: unknown) => ({ workspaceId: "ws-team" })),
  cancel: vi.fn(async (_input: unknown) => ({ ok: true })),
};

const invalidate = vi.fn(async () => undefined);
const utils = {
  members: { list: { invalidate } },
  workspaces: { list: { invalidate } },
  invitations: { list: { invalidate } },
};

const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
  useMutation: () => ({ mutateAsync: fn }),
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => utils,
    workspaces: {
      list: {
        useQuery: () => ({
          data: state.workspaces,
          isPending: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      create: mutation((input) => calls.createWorkspace(input)),
    },
    settings: {
      get: { useQuery: () => ({ data: { currency: "CHF", weekStartsOn: 0 } }) },
    },
    members: {
      list: {
        useQuery: () => ({ data: state.members, isPending: false, isError: false }),
      },
      updateRate: mutation((input) => calls.updateRate(input)),
      updateRole: mutation((input) => calls.updateRole(input)),
      updateVisibility: mutation((input) => calls.updateVisibility(input)),
      remove: mutation((input) => calls.remove(input)),
      transferOwnership: mutation((input) => calls.transferOwnership(input)),
      leave: mutation((input) => calls.leave(input)),
    },
    invitations: {
      list: {
        useQuery: (input: unknown, options: { enabled?: boolean }) => {
          invitationsListQuery(input, options);
          return {
            data: options.enabled === false ? undefined : state.invitations,
            isPending: false,
          };
        },
      },
      create: mutation((input) => calls.create(input)),
      cancel: mutation((input) => calls.cancel(input)),
    },
  },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { MembersScreen } = await import("./members-screen");

const invitation: PendingInvitation = {
  id: "inv-1",
  email: "bob@example.com",
  role: "member",
  inviterName: "Olivia Owner",
  expiresAt: "2026-09-21T10:00:00.000Z",
  inviteUrl: "https://trackyourtime.dev/invite/?id=inv-1",
};

const as = (role: WorkspaceSummary["role"], members = teamRows(role)): void => {
  state.workspaces = [workspaceFor(role)];
  state.members = members;
  state.invitations = [invitation];
};

const everyInput = (): unknown[] =>
  Object.values(calls).flatMap((fn) => fn.mock.calls.map((call) => call[0]));

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockClear();
  invitationsListQuery.mockClear();
  window.localStorage.clear();
});

afterEach(cleanup);

describe("MembersScreen as a plain member", () => {
  it("never asks for invitations and shows no invite form or link", () => {
    as("member");
    render(<MembersScreen navigate={vi.fn()} />);

    expect(invitationsListQuery).toHaveBeenCalled();
    for (const [, options] of invitationsListQuery.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ enabled: false }));
    }
    expect(screen.queryByTestId("invite-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pending-invitations")).not.toBeInTheDocument();
    expect(screen.queryByText(/invite\/\?id=/)).not.toBeInTheDocument();
  });

  it("leaves after confirming, stores the next workspace and reloads into /track/", async () => {
    as("member");
    const navigate = vi.fn();
    render(<MembersScreen navigate={navigate} />);

    fireEvent.click(screen.getByTestId("leave-workspace-button"));
    expect(await screen.findByTestId("leave-workspace-dialog")).toBeInTheDocument();
    expect(calls.leave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-accept"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/track/"));
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-personal");
    expect(calls.leave).toHaveBeenCalledWith(undefined);
  });
});

describe("MembersScreen in a personal workspace", () => {
  const personal = (): void => {
    state.workspaces = [workspaceFor("owner", { kind: "personal", memberCount: 1 })];
    state.members = [memberRow({ memberId: "me", role: "owner", isSelf: true })];
    state.invitations = [];
  };

  it("offers no invitations, cannot be left, and points at a team workspace", () => {
    personal();
    render(<MembersScreen navigate={vi.fn()} />);
    expect(screen.queryByTestId("invite-card")).not.toBeInTheDocument();
    for (const [, options] of invitationsListQuery.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ enabled: false }));
    }
    expect(screen.getByTestId("personal-workspace-card")).toBeInTheDocument();
    expect(screen.getByTestId("leave-workspace-button")).toBeDisabled();
    expect(screen.getByTestId("leave-workspace")).toHaveTextContent("This is your personal workspace");
  });

  it("creates a team workspace with the current settings and reloads into it", async () => {
    personal();
    const navigate = vi.fn();
    render(<MembersScreen navigate={navigate} />);

    fireEvent.click(screen.getByTestId("personal-workspace-create"));
    await screen.findByTestId("new-workspace-dialog");
    expect(screen.getByTestId("new-workspace-submit")).toBeDisabled();
    expect(screen.getByTestId("new-workspace-currency")).toHaveValue("CHF");
    expect(screen.getByTestId("new-workspace-week-start")).toHaveValue("0");

    fireEvent.change(screen.getByTestId("new-workspace-name"), { target: { value: "  Ole & Rico " } });
    fireEvent.change(screen.getByTestId("new-workspace-currency"), { target: { value: "EUR" } });
    fireEvent.click(screen.getByTestId("new-workspace-submit"));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/track/"));
    expect(calls.createWorkspace).toHaveBeenCalledWith({
      name: "Ole & Rico",
      currency: "EUR",
      weekStartsOn: 0,
    });
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-team");
  });

  it("shows the refusal and stays put when creation is refused", async () => {
    personal();
    calls.createWorkspace.mockRejectedValueOnce(
      Object.assign(new Error("workspace-limit-reached"), { data: { code: "FORBIDDEN" } }),
    );
    const navigate = vi.fn();
    render(<MembersScreen navigate={navigate} />);
    fireEvent.click(screen.getByTestId("personal-workspace-create"));
    fireEvent.change(await screen.findByTestId("new-workspace-name"), { target: { value: "One more" } });
    fireEvent.click(screen.getByTestId("new-workspace-submit"));
    expect(await screen.findByTestId("new-workspace-error")).toHaveTextContent(
      "You own the maximum number of workspaces",
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("MembersScreen as owner", () => {
  it("shows the invite form and pending invitations with their links", () => {
    as("owner");
    render(<MembersScreen navigate={vi.fn()} />);
    expect(screen.getByTestId("invite-card")).toBeInTheDocument();
    expect(screen.getByTestId("invitation-link-inv-1")).toHaveValue(invitation.inviteUrl);
  });

  it("removes a member only after the dialog is confirmed", async () => {
    as("owner");
    render(<MembersScreen navigate={vi.fn()} />);

    fireEvent.click(screen.getByTestId("member-remove-member"));
    const dialog = await screen.findByTestId("member-remove-dialog");
    expect(dialog).toHaveTextContent("Remove Mia Member?");
    expect(calls.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("member-remove-dialog")).not.toBeInTheDocument(),
    );
    expect(calls.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("member-remove-member"));
    await screen.findByTestId("member-remove-dialog");
    fireEvent.click(screen.getByTestId("confirm-accept"));
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith({ memberId: "member" }));
  });

  it("transfers ownership only after the dialog is confirmed", async () => {
    as("owner");
    render(<MembersScreen navigate={vi.fn()} />);

    fireEvent.click(screen.getByTestId("member-transfer-admin"));
    expect(await screen.findByTestId("member-transfer-dialog")).toHaveTextContent(
      "Make Adam Admin the owner?",
    );
    expect(calls.transferOwnership).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-accept"));
    await waitFor(() =>
      expect(calls.transferOwnership).toHaveBeenCalledWith({ memberId: "admin" }),
    );
  });

  it("as the last owner cannot leave, and is told to transfer ownership first", () => {
    as("owner");
    render(<MembersScreen navigate={vi.fn()} />);
    expect(screen.getByTestId("leave-workspace-button")).toBeDisabled();
    expect(screen.getByTestId("leave-workspace-blocked")).toHaveTextContent(
      "Transfer ownership first.",
    );
  });

  it("can leave when another owner remains", () => {
    as("owner", [
      ...teamRows("owner"),
      memberRow({ memberId: "owner2", role: "owner", canViewOthersTime: true, canViewOthersMoney: true }),
    ]);
    render(<MembersScreen navigate={vi.fn()} />);
    expect(screen.getByTestId("leave-workspace-button")).toBeEnabled();
  });

  it("cancels an invitation", async () => {
    as("owner");
    render(<MembersScreen navigate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("invitation-cancel-inv-1"));
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledWith({ invitationId: "inv-1" }));
  });

  it("never names a workspace in any membership call", async () => {
    as("owner");
    render(<MembersScreen navigate={vi.fn()} />);
    fireEvent.change(screen.getByTestId("member-role-select-member"), {
      target: { value: "admin" },
    });
    fireEvent.click(screen.getByTestId("member-time-toggle-admin"));
    fireEvent.click(screen.getByTestId("invitation-cancel-inv-1"));
    await waitFor(() => expect(calls.cancel).toHaveBeenCalled());
    await waitFor(() => expect(calls.updateVisibility).toHaveBeenCalled());
    for (const input of everyInput()) {
      expect(JSON.stringify(input ?? {})).not.toContain("workspaceId");
    }
  });
});
