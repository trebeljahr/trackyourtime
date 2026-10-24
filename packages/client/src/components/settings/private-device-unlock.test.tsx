// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { encryptPrivateDeviceApproval, privateDeviceInviteFromHash } from "@starter/core";
const state = vi.hoisted(() => ({ create: vi.fn(), poll: vi.fn(), cancel: vi.fn(), open: vi.fn(), install: vi.fn() }));
vi.mock("@starter/core", async () => ({ ...await vi.importActual("@starter/core"), checkServer: async () => ({ ok: true, server: { webUrl: "https://app.example.test" } }) }));
vi.mock("@/lib/private-device", async () => ({ privateDeviceWebOrigin: () => "https://app.example.test", PrivateDeviceWebOriginError: class extends Error {}, createPrivateDeviceUnlock: async () => {
  const { createPrivateDeviceReceiver } = await vi.importActual<typeof import("@starter/core")>("@starter/core");
  const receiver = await createPrivateDeviceReceiver({ server: "https://api.example.test", userId: "owner" });
  return { invite: receiver.invite, accept: receiver.accept, cancel: receiver.cancel, confirm: (code: string) => state.install(receiver.confirm(code)) };
} }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test" }));
vi.mock("@/lib/shell", () => ({ isElectron: () => true }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: {
  createDeviceUnlock: { useMutation: () => ({ mutateAsync: state.create }) }, deviceUnlockStatus: { useMutation: () => ({ mutateAsync: state.poll }) }, cancelDeviceUnlock: { useMutation: () => ({ mutateAsync: state.cancel }) },
} } }));
const { PrivateDeviceUnlock } = await import("./private-device-unlock");
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  for (const fn of Object.values(state)) fn.mockReset();
  state.create.mockResolvedValue({}); state.cancel.mockResolvedValue(undefined); state.open.mockResolvedValue(true);
  Object.defineProperty(window, "electronAPI", { value: { openExternal: state.open }, configurable: true });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "electronAPI"); vi.unstubAllGlobals(); });
it("polls once per request state, requires the browser code and never submits that code to the relay", async () => {
  let deliver!: (value: unknown) => void;
  state.poll.mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
  render(<PrivateDeviceUnlock userId="owner" />);
  fireEvent.click(screen.getByText("Unlock with your browser"));
  await waitFor(() => expect(state.poll).toHaveBeenCalledTimes(1));
  const invite = privateDeviceInviteFromHash(new URL(state.open.mock.calls[0]![0]).hash);
  const response = await encryptPrivateDeviceApproval(invite, { master: "synthetic-private-key" });
  await act(async () => deliver({ box: response.approval }));
  const input = await screen.findByLabelText("8-character code from your browser");
  expect(state.install).not.toHaveBeenCalled(); expect(state.poll).toHaveBeenCalledTimes(1);
  const wrong = response.code === "00000000" ? "11111111" : "00000000";
  fireEvent.change(input, { target: { value: wrong } }); fireEvent.click(screen.getByText("Confirm and unlock"));
  expect(state.install).not.toHaveBeenCalled(); expect(screen.getByRole("alert").textContent).toMatch(/did not match/);
  fireEvent.change(input, { target: { value: response.code } }); fireEvent.click(screen.getByText("Confirm and unlock"));
  expect(state.install).toHaveBeenCalledWith({ master: "synthetic-private-key" });
  expect(state.cancel).toHaveBeenCalledWith({ requestId: invite.requestId });
  expect(JSON.stringify([state.create.mock.calls, state.poll.mock.calls, state.cancel.mock.calls])).not.toContain(response.code);
});
it("cancels a pending delivery when the screen closes without installing a late response", async () => {
  let deliver!: (value: unknown) => void;
  state.poll.mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
  const { unmount } = render(<PrivateDeviceUnlock userId="owner" />);
  fireEvent.click(screen.getByText("Unlock with your browser"));
  await waitFor(() => expect(state.poll).toHaveBeenCalledTimes(1));
  const invite = privateDeviceInviteFromHash(new URL(state.open.mock.calls[0]![0]).hash);
  const response = await encryptPrivateDeviceApproval(invite, { master: "synthetic-private-key" });
  unmount(); await act(async () => deliver({ box: response.approval }));
  expect(state.cancel).toHaveBeenCalledWith({ requestId: invite.requestId });
  expect(state.install).not.toHaveBeenCalled();
});
