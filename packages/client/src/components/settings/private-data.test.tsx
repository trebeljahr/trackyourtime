// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
const state = vi.hoisted(() => ({ identity: null as unknown, current: null as unknown, refetch: vi.fn(), newIdentity: vi.fn(), enroll: vi.fn(), cached: null as unknown, cacheFailed: false, apiFailed: false, remember: vi.fn(), unlock: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/hooks/use-shell", () => ({ useIsTokenShell: () => false }));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => false }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", unlockPrivateRecovery: state.unlock, privateSession: () => state.current, subscribePrivateSession: () => () => {}, newPrivateIdentity: state.newIdentity }));
vi.mock("@/lib/private-account-setup", () => ({ preparePrivateAccountSetup: state.newIdentity, finishPrivateAccountSetup: state.enroll }));
vi.mock("@/lib/private-identity-cache", () => ({ cachedPrivateIdentity: async () => { if (state.cacheFailed) throw new Error("Corrupt"); return state.cached; }, rememberPrivateIdentity: state.remember, samePrivateIdentityKeys: (a: { key?: string }, b: { key?: string }) => a.key === b.key }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: { identity: { useQuery: () => ({ data: state.identity ? { identity: state.identity } : null, isLoading: false, isError: state.apiFailed, refetch: state.refetch }) }, enroll: { useMutation: () => ({ mutateAsync: state.enroll }) }, updateIdentity: { useMutation: () => ({}) } } } }));
vi.mock("./private-key-code", () => ({ PrivateKeyCode: () => null }));
vi.mock("./private-activity", () => ({ PrivateActivity: () => null }));
vi.mock("./private-device-unlock", () => ({ PrivateDeviceUnlock: () => null }));
const { PrivateDataCard } = await import("./private-data");
beforeEach(() => { state.identity = null; state.current = null; state.refetch.mockReset().mockResolvedValue({}); state.cached = null; state.cacheFailed = false; state.apiFailed = false; state.remember.mockReset().mockImplementation(async (_id, identity) => identity); state.unlock.mockReset(); state.newIdentity.mockReset(); state.enroll.mockReset(); });
afterEach(cleanup);
it("finishes the guarded setup and leaves no stale setup form when optional device-envelope caching fails", async () => {
  const draft = { identity: { passkeys: [] }, secrets: {}, recoveryKey: "R".repeat(43), assertCurrent: vi.fn() };
  state.newIdentity.mockResolvedValue(draft); state.enroll.mockImplementation(async () => { state.current = {}; }); state.remember.mockRejectedValue(new Error("Storage unavailable"));
  render(<PrivateDataCard />); fireEvent.click(await screen.findByText("Set up private data keys"));
  fireEvent.change(await screen.findByLabelText("Enter its last 8 characters to confirm you saved it"), { target: { value: "R".repeat(8) } });
  fireEvent.click(screen.getByText("Save private data keys"));
  await vi.waitFor(() => expect(state.refetch).toHaveBeenCalledOnce()); expect(state.enroll).toHaveBeenCalledWith(draft);
  expect(screen.queryByText("Save private data keys")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toBeInTheDocument();
});
it("never offers replacement root keys when unlocking an enrolled private device", async () => {
  render(<PrivateDataCard unlockOnly />);
  expect(await screen.findByRole("status")).toHaveTextContent("existing encryption keys are unavailable"); expect(screen.queryByText("Set up private data keys")).not.toBeInTheDocument(); expect(state.newIdentity).not.toHaveBeenCalled(); expect(state.enroll).not.toHaveBeenCalled();
});
it("retains explicit initial setup for standard accounts and recovery unlock for an existing identity", async () => {
  const first = render(<PrivateDataCard />); expect(await screen.findByText("Set up private data keys")).toBeEnabled(); first.unmount();
  state.identity = { passkeys: [] }; render(<PrivateDataCard unlockOnly />); expect(await screen.findByLabelText("Recovery key")).toBeInTheDocument(); expect(screen.getByText("Unlock with passkey")).toBeDisabled(); expect(screen.queryByText("Set up private data keys")).not.toBeInTheDocument();
});

it("uses saved envelopes during an outage and clears the recovery input after unlocking", async () => {
  state.cached = { passkeys: [], key: "old-root" }; state.apiFailed = true;
  render(<PrivateDataCard unlockOnly />);
  const input = await screen.findByLabelText("Recovery key");
  fireEvent.change(input, { target: { value: "R".repeat(43) } }); fireEvent.click(screen.getByText("Unlock with recovery key"));
  await vi.waitFor(() => expect(state.remember).toHaveBeenCalledWith("owner", state.cached, "R".repeat(43)));
  expect(state.unlock).toHaveBeenCalledWith("owner", state.cached, "R".repeat(43)); expect(input).toHaveValue("");
  expect(screen.getByText(/Using this device’s saved/)).toBeInTheDocument(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("keeps cached roots when a server advertises replacements", async () => {
  state.cached = { passkeys: [], key: "old-root" }; state.identity = { passkeys: [], key: "replacement" };
  render(<PrivateDataCard unlockOnly />);
  expect(await screen.findByText(/server reports different encryption keys/)).toBeInTheDocument();
  expect(screen.getByLabelText("Recovery key")).toBeInTheDocument(); expect(state.newIdentity).not.toHaveBeenCalled();
});
it("does not fall back to server keys or setup after saved keys fail verification", async () => {
  state.cacheFailed = true; state.identity = { passkeys: [] }; render(<PrivateDataCard />);
  expect(await screen.findByText(/saved encryption keys could not be read/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Recovery key")).not.toBeInTheDocument(); expect(screen.queryByText("Set up private data keys")).not.toBeInTheDocument();
});
