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
  updateRole: vi.fn(async (_input: unknown) => ({})),
  updateVisibility: vi.fn(async (_input: unknown) => ({})),
  remove: vi.fn(async (_input: unknown) => ({ ok: true })),
  transferOwnership: vi.fn(async (_input: unknown) => ({ ok: true })),
  leave: vi.fn(async (_input: unknown) => ({ nextWorkspaceId: "ws-personal" })),
  create: vi.fn(async (_input: unknown) => ({})),
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
    },
    members: {
      list: {
        useQuery: () => ({ data: state.members, isPending: false, isError: false }),
      },
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
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/track/"));
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-personal");
    expect(calls.leave).toHaveBeenCalledWith(undefined);
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
