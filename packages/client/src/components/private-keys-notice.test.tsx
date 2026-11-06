// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The account keys' notices: a new recovery key until it is saved, keys a
 * reset left closed, and a reset seen from a device that holds the keys open.
 */
const state = vi.hoisted(() => ({
  recoveryKey: null as string | null, needsRecovery: false, stale: false,
  listeners: new Set<() => void>(), saved: vi.fn(), repair: vi.fn(), unlock: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: { identity: { useQuery: () => ({ data: { identity: { recovery: {} }, revision: 1 } }) } } } }));
vi.mock("@/lib/private-identity-cache", () => ({ rememberPrivateIdentity: async () => ({}) }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => ({}), subscribePrivateSession: () => () => {}, unlockPrivateRecovery: state.unlock }));
vi.mock("@/lib/password-unlock", () => {
  class WrongPasswordError extends Error {}
  return {
    WrongPasswordError,
    checkPasswordKeysStale: async () => {},
    passwordKeysNeedRecovery: () => state.needsRecovery,
    passwordKeysStale: () => state.stale,
    recoveryKeyToSave: () => state.recoveryKey,
    recoveryKeySaved: () => { state.saved(); state.recoveryKey = null; for (const listener of state.listeners) listener(); },
    repairKeysWithPassword: state.repair,
    subscribePasswordUnlockNotices: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
});

const { PrivateKeysNotice } = await import("@/components/private-keys-notice");
const { WrongPasswordError } = await import("@/lib/password-unlock");
const KEY = "A".repeat(43);

beforeEach(() => {
  state.recoveryKey = null; state.needsRecovery = false; state.stale = false;
  state.saved.mockReset(); state.repair.mockReset(); state.unlock.mockReset();
});
afterEach(cleanup);

it("shows a new recovery key until the person says they saved it", async () => {
  state.recoveryKey = KEY;
  render(<PrivateKeysNotice />);
  expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent(KEY);
  fireEvent.click(screen.getByTestId("recovery-key-saved"));
  expect(state.saved).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByTestId("private-keys-notice")).toBeNull());
});

it("puts a notice off until the next page load with Later", async () => {
  state.recoveryKey = KEY;
  render(<PrivateKeysNotice />);
  fireEvent.click(await screen.findByRole("button", { name: "Later" }));
  expect(screen.queryByTestId("private-keys-notice")).toBeNull();
  expect(state.saved).not.toHaveBeenCalled();
});

it("opens keys a reset left closed with the recovery key", async () => {
  state.needsRecovery = true;
  render(<PrivateKeysNotice />);
  const input = await screen.findByTestId("recover-keys-input");
  fireEvent.change(input, { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Open with recovery key" }));
  await waitFor(() => expect(state.unlock).toHaveBeenCalledWith("user-1", { recovery: {} }, KEY));
});

it("says so when the typed password is not the current one", async () => {
  state.stale = true;
  state.repair.mockRejectedValue(new WrongPasswordError());
  render(<PrivateKeysNotice />);
  fireEvent.change(await screen.findByTestId("update-keys-password"), { target: { value: "a typo" } });
  fireEvent.click(screen.getByRole("button", { name: "Update keys" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That is not the account's current password.");
});
