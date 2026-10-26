// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
const state = vi.hoisted(() => ({ identity: null as unknown, newIdentity: vi.fn(), enroll: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/hooks/use-shell", () => ({ useIsTokenShell: () => false }));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => false }));
vi.mock("@/lib/private-session", () => ({ privateSession: () => null, subscribePrivateSession: () => () => {}, newPrivateIdentity: state.newIdentity }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: { identity: { useQuery: () => ({ data: state.identity ? { identity: state.identity } : null, isLoading: false, isError: false }) }, enroll: { useMutation: () => ({ mutateAsync: state.enroll }) }, updateIdentity: { useMutation: () => ({}) } } } }));
vi.mock("./private-key-code", () => ({ PrivateKeyCode: () => null }));
vi.mock("./private-activity", () => ({ PrivateActivity: () => null }));
vi.mock("./private-device-unlock", () => ({ PrivateDeviceUnlock: () => null }));
const { PrivateDataCard } = await import("./private-data");
beforeEach(() => { state.identity = null; state.newIdentity.mockReset(); state.enroll.mockReset(); });
afterEach(cleanup);
it("never offers replacement root keys when unlocking an enrolled private device", () => {
  render(<PrivateDataCard unlockOnly />);
  expect(screen.getByRole("status")).toHaveTextContent("existing encryption keys are unavailable"); expect(screen.queryByText("Set up private data keys")).not.toBeInTheDocument(); expect(state.newIdentity).not.toHaveBeenCalled(); expect(state.enroll).not.toHaveBeenCalled();
});
it("retains explicit initial setup for standard accounts and recovery unlock for an existing identity", () => {
  const first = render(<PrivateDataCard />); expect(screen.getByText("Set up private data keys")).toBeEnabled(); first.unmount();
  state.identity = { passkeys: [] }; render(<PrivateDataCard unlockOnly />); expect(screen.getByLabelText("Recovery key")).toBeInTheDocument(); expect(screen.getByText("Unlock with passkey")).toBeDisabled(); expect(screen.queryByText("Set up private data keys")).not.toBeInTheDocument();
});
