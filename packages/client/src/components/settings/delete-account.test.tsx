// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { AccountDeletionRefusal } from "@/lib/auth-client";

/**
 * Deleting an account is the most destructive button in the app. What these
 * pin: nothing is sent until the dialog has said what goes and what stays and
 * the person has confirmed with their password (or, with no password, their
 * email); a refusal leaves them in the dialog with a reason and no redirect;
 * and only a real success leaves for /login.
 */

const replace = vi.fn();
const state = { pending: 0 };
const preview = { data: { soloWorkspaces: 1, standardSharedWorkspaces: 0, encryptedSharedWorkspaces: 1 }, isFetching: false, isError: false };
let previewSupported = false;
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => previewSupported }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: { deletionPreview: { useQuery: () => preview } } } }));
const auth = { user: { id: "user-a", name: "Alice", email: "alice@example.com" } };
let hasPassword = true;
let outcome: { ok: true } | { ok: false; reason: AccountDeletionRefusal } = { ok: true };
const deleteAccount = vi.fn<
  (args: { userId: string; password?: string }) => Promise<typeof outcome>
>(async () => outcome);

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/providers/offline-queue-provider", () => ({
  useOfflineQueueState: () => state,
}));
vi.mock("@/lib/auth-client", () => ({
  accountHasPassword: async () => hasPassword,
  deleteAccount: (args: { userId: string; password?: string }) => deleteAccount(args),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { DeleteAccountCard } = await import("./delete-account");

const openDialog = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId("delete-account"));
  await screen.findByTestId("delete-account-dialog");
};

beforeEach(() => {
  previewSupported = false; preview.isFetching = false; preview.isError = false; preview.data.standardSharedWorkspaces = 0; preview.data.encryptedSharedWorkspaces = 1;
  replace.mockClear();
  deleteAccount.mockClear();
  state.pending = 0;
  hasPassword = true;
  outcome = { ok: true };
});

afterEach(cleanup);

describe("DeleteAccountCard", () => {
  it("sends nothing on the first click — it opens a dialog that says what goes", async () => {
    const onShowExport = vi.fn();
    render(<DeleteAccountCard onShowExport={onShowExport} />);
    await openDialog();

    expect(deleteAccount).not.toHaveBeenCalled();
    const scope = screen.getByTestId("delete-account-scope");
    expect(scope).toHaveTextContent("time entries, clients, projects, tasks, tags");
    expect(scope).toHaveTextContent("In workspaces you share, only your own data is deleted");
    expect(scope).toHaveTextContent("entries already on an invoice");
    expect(scope).toHaveTextContent("Backup files you saved on your devices stay there");

    fireEvent.click(screen.getByTestId("delete-account-export"));
    expect(onShowExport).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByTestId("delete-account-dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps the confirm button disabled until a password is typed, then sends it", async () => {
    render(<DeleteAccountCard />);
    await openDialog();

    const confirm = await screen.findByTestId("delete-account-confirm");
    await screen.findByTestId("delete-account-password");
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByTestId("delete-account-password"), {
      target: { value: "hunter22" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(deleteAccount).toHaveBeenCalledWith({ userId: "user-a", password: "hunter22" });
  });

  it("stays in the dialog with the reason when the password is wrong", async () => {
    outcome = { ok: false, reason: "invalid-password" };
    render(<DeleteAccountCard />);
    await openDialog();

    fireEvent.change(await screen.findByTestId("delete-account-password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    expect(await screen.findByTestId("delete-account-error")).toHaveTextContent(
      "That password is not correct",
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("delete-account-dialog")).toBeInTheDocument();
  });

  it("with no password, asks for the email and sends no password", async () => {
    hasPassword = false;
    render(<DeleteAccountCard />);
    await openDialog();

    const field = await screen.findByTestId("delete-account-email");
    const confirm = screen.getByTestId("delete-account-confirm");
    fireEvent.change(field, { target: { value: "someone@else.com" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(field, { target: { value: " Alice@Example.com " } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(deleteAccount).toHaveBeenCalledWith({ userId: "user-a", password: undefined });
  });

  it("tells a no-password account with an old session to sign in again", async () => {
    hasPassword = false;
    outcome = { ok: false, reason: "session-expired" };
    render(<DeleteAccountCard />);
    await openDialog();

    fireEvent.change(await screen.findByTestId("delete-account-email"), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    expect(await screen.findByTestId("delete-account-error")).toHaveTextContent(
      "sign in again",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("warns that unsynced changes on this device will be discarded", async () => {
    state.pending = 2;
    render(<DeleteAccountCard />);
    await openDialog();
    expect(screen.getByTestId("delete-account-unsynced")).toHaveTextContent(
      "2 changes on this device have not synced yet",
    );
  });
});


it("explains encrypted shared retention without promising to erase shared time entries", async () => {
  previewSupported = true; render(<DeleteAccountCard />); await openDialog();
  expect(screen.getByTestId("delete-account-encrypted-shared")).toHaveTextContent("including your time entries");
  expect(screen.getByTestId("delete-account-encrypted-shared")).toHaveTextContent("account encryption keys are deleted");
  expect(screen.getByTestId("delete-account-scope")).not.toHaveTextContent("only your own data is deleted");
});
it("shows both retention policies when an account belongs to both workspace modes", async () => {
  previewSupported = true; preview.data.standardSharedWorkspaces = 1; render(<DeleteAccountCard />); await openDialog();
  expect(screen.getByTestId("delete-account-scope")).toHaveTextContent("entries already on an invoice");
  expect(screen.getByTestId("delete-account-encrypted-shared")).toBeInTheDocument();
});
it("holds confirmation until the workspace policy is current, including failed refreshes", async () => {
  previewSupported = true; preview.isFetching = true; const { rerender } = render(<DeleteAccountCard />); await openDialog();
  fireEvent.change(await screen.findByTestId("delete-account-password"), { target: { value: "correct password" } });
  expect(screen.getByTestId("delete-account-confirm")).toBeDisabled();
  preview.isFetching = false; preview.isError = true; rerender(<DeleteAccountCard />);
  expect(screen.getByTestId("delete-account-preview-status")).toHaveTextContent("Could not check");
  expect(screen.getByTestId("delete-account-confirm")).toBeDisabled();
  expect(deleteAccount).not.toHaveBeenCalled();
  preview.isError = false; rerender(<DeleteAccountCard />); expect(screen.getByTestId("delete-account-confirm")).toBeEnabled();
});
