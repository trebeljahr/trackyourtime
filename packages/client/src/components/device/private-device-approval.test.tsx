// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPrivateDeviceReceiver, encryptPrivateDeviceApproval, privateDeviceUrl } from "@starter/core";
const state = vi.hoisted(() => ({ userId: "owner", poll: vi.fn(), approve: vi.fn(), seal: vi.fn(), response: null as unknown }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: state.userId, email: "synthetic@example.test" }, isLoading: false }) }));
vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/private-device", () => ({ sealPrivateDeviceUnlock: state.seal }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => ({}), subscribePrivateSession: () => () => {} }));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => true, refreshServerLevel: async () => {} }));
vi.mock("@/components/settings/private-data", () => ({ PrivateDataCard: () => null }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: {
  identity: { useQuery: () => ({ data: { identity: {}, revision: 1 } }) }, deviceUnlockStatus: { useMutation: () => ({ mutateAsync: state.poll }) }, approveDeviceUnlock: { useMutation: () => ({ mutateAsync: state.approve }) },
} } }));
const { PrivateDeviceApproval } = await import("./private-device-approval");
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); state.userId = "owner";
  state.poll.mockReset().mockResolvedValue({ box: null }); state.approve.mockReset(); state.seal.mockReset();
  const native = await createPrivateDeviceReceiver({ server: "https://api.example.test", userId: "owner" });
  const url = new URL(privateDeviceUrl(window.location.origin, native.invite)); window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
  state.response = await encryptPrivateDeviceApproval(native.invite, { master: "synthetic-private-root" });
  state.seal.mockResolvedValue(state.response); native.cancel();
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });
it("keeps the original code and ciphertext after a lost reply and retries without re-encrypting the identity", async () => {
  state.approve.mockRejectedValueOnce(new Error("lost reply")).mockResolvedValue(undefined);
  render(<PrivateDeviceApproval />);
  const button = await screen.findByText("Approve private data access");
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not complete/));
  const code = screen.getByTestId("private-device-approval-code").textContent;
  fireEvent.click(screen.getByText("Send the same response again"));
  await waitFor(() => expect(state.approve).toHaveBeenCalledTimes(2));
  expect(state.seal).toHaveBeenCalledTimes(1);
  expect(state.approve.mock.calls[0]![0]).toEqual(state.approve.mock.calls[1]![0]);
  expect(screen.getByTestId("private-device-approval-code").textContent).toBe(code);
  expect(JSON.stringify(state.approve.mock.calls)).not.toContain("synthetic-private-root");
  expect(JSON.stringify(state.approve.mock.calls)).not.toContain(code!.replace(/\s/g, ""));
});
it("does not fetch or approve a request for a different signed-in account", async () => {
  state.userId = "other";
  render(<PrivateDeviceApproval />);
  await screen.findByText(/Use the same account as your app/);
  expect(state.poll).not.toHaveBeenCalled(); expect(state.approve).not.toHaveBeenCalled(); expect(state.seal).not.toHaveBeenCalled();
});
