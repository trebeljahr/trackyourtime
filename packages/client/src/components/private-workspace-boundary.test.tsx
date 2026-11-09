// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ required: vi.fn(), confirm: vi.fn(), reset: vi.fn(), unknown: false, inventory: false, mounts: 0, unmounts: 0, device: 0, keys: false, version: 0, routing: 0, epoch: "0", listeners: new Set<() => void>(), signOut: vi.fn() }));
vi.mock("@/lib/private-session", () => ({ privateAccountId: () => "owner", privateOperationScope: () => () => {}, privateDataOrigin: () => "https://api.example.test", privateSession: () => state.keys ? {} : null, privateSessionVersion: () => state.version, subscribePrivateSession: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@/lib/private-routing-requirement", () => ({ privateRoutingRequired: state.required, privateRoutingRevision: () => state.routing, subscribePrivateRoutingRequirement: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ resetQueries: state.reset }) }));
vi.mock("@/lib/private-device-access", () => ({ confirmStandardDeviceAccess: state.confirm, privateDeviceAccessRevision: () => state.device, subscribePrivateDeviceAccess: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@/lib/private-device-access-state", () => ({ readPrivateDeviceAccessState: async (userId: string) => await state.required({ userId }) ? state.keys ? state.inventory ? "inventory" : "ready" : "locked" : state.unknown ? "unknown" : "standard" }));
vi.mock("./settings/private-device-unlock", () => ({ PrivateDeviceUnlock: () => { const [draft, setDraft] = React.useState(0); React.useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []); return <button onClick={() => setDraft((n) => n + 1)}>Approval request {draft}</button>; } }));
vi.mock("@/lib/private-view-lifecycle", () => ({ privateViewMountKey: () => state.epoch, subscribePrivateViewEpoch: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@/lib/api-origin", () => ({ whenApiOriginReady: async () => {} }));
vi.mock("@/lib/auth-client", () => ({ signOut: state.signOut }));
vi.mock("./startup-screen", () => ({ StartupScreen: () => <p>Checking device</p> }));
vi.mock("./settings/private-data", () => ({ PrivateDataCard: ({ unlockOnly }: { unlockOnly?: boolean }) => <p data-testid="unlock-controls">{unlockOnly ? "Existing keys only" : "May create keys"}</p> }));
const { PrivateWorkspaceBoundary } = await import("./private-workspace-boundary");
beforeEach(() => { state.unknown = false; state.inventory = false; state.mounts = 0; state.unmounts = 0; state.device = 0; state.reset.mockReset().mockResolvedValue(undefined); state.confirm.mockReset().mockImplementation(async () => { state.unknown = false; state.device++; for (const listener of state.listeners) listener(); }); state.required.mockReset(); state.required.mockResolvedValue(false); state.keys = false; state.version = 0; state.routing = 0; state.epoch = "0"; });
afterEach(cleanup);
function Draft() { const [draft, setDraft] = React.useState(0); return <button onClick={() => setDraft((value) => value + 1)}>Private draft {draft}</button>; }
const changeKeys = (keys: boolean) => act(() => { state.keys = keys; state.version++; state.epoch = String(state.version); for (const listener of state.listeners) listener(); });
it("keeps standard accounts available and preserves their forms across optional key setup", async () => {
  render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  fireEvent.click(await screen.findByText("Private draft 0")); expect(screen.getByText("Private draft 1")).toBeInTheDocument();
  act(() => { state.keys = true; state.version++; for (const listener of state.listeners) listener(); });
  expect(screen.getByText("Private draft 1")).toBeInTheDocument(); expect(screen.queryByTestId("unlock-controls")).not.toBeInTheDocument();
});
it("hides private forms while locked, offers existing keys and drops derived component state across re-unlock", async () => {
  state.required.mockResolvedValue(true); render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  expect(screen.queryByText("Private draft 0")).not.toBeInTheDocument(); expect(await screen.findByTestId("unlock-controls")).toHaveTextContent("Existing keys only");
  changeKeys(true); fireEvent.click(await screen.findByText("Private draft 0")); expect(screen.getByText("Private draft 1")).toBeInTheDocument();
  changeKeys(false); await screen.findByTestId("unlock-controls"); expect(screen.queryByText("Private draft 1")).not.toBeInTheDocument();
  changeKeys(true); await screen.findByText("Private draft 0"); expect(screen.queryByText("Private draft 1")).not.toBeInTheDocument();
});
it("fails closed on denied metadata and retries without offering replacement keys", async () => {
  state.required.mockRejectedValueOnce(new Error("Storage denied")); render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Existing work was kept"); expect(screen.queryByTestId("unlock-controls")).not.toBeInTheDocument(); expect(screen.queryByText("Private draft 0")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Try again")); await screen.findByText("Private draft 0");
});
it("does not apply a late account’s requirement to the account now on screen", async () => {
  let resume!: (value: boolean) => void; state.required.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve; }));
  const view = render(<PrivateWorkspaceBoundary userId="previous"><Draft /></PrivateWorkspaceBoundary>); await waitFor(() => expect(state.required).toHaveBeenCalledOnce());
  view.rerender(<PrivateWorkspaceBoundary userId="current"><Draft /></PrivateWorkspaceBoundary>); await screen.findByText("Private draft 0");
  await act(async () => { resume(true); }); expect(screen.getByText("Private draft 0")).toBeInTheDocument(); expect(screen.queryByTestId("unlock-controls")).not.toBeInTheDocument();
});

it("enrolls an unknown device in standard storage without asking anyone to choose", async () => {
  state.unknown = true; render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  await screen.findByText("Private draft 0"); expect(state.confirm).toHaveBeenCalledOnce();
  // The refused-query reset runs in an effect after the forms paint, so a slow run can see the draft first.
  await waitFor(() => expect(state.reset).toHaveBeenCalled());
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(screen.queryByTestId("unlock-controls")).not.toBeInTheDocument();
});
it("shows the failure with a retry when silent enrollment is refused, and never mounts forms meanwhile", async () => {
  state.unknown = true; state.confirm.mockRejectedValueOnce(new Error("Storage denied"));
  render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Existing work was kept"); expect(screen.queryByText("Private draft 0")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Try again")); await screen.findByText("Private draft 0"); expect(state.confirm).toHaveBeenCalledTimes(2);
});
it("keeps an approval request alive while its routing protection and checkpoint are being saved", async () => {
  state.required.mockResolvedValue(true); render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  fireEvent.click(await screen.findByText("Approval request 0"));
  act(() => { state.routing++; for (const listener of state.listeners) listener(); });
  await screen.findByText("Approval request 1"); expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0); expect(state.confirm).not.toHaveBeenCalled();
  changeKeys(true); await screen.findByText("Private draft 0"); expect(state.unmounts).toBe(1);
});
it("keeps forms hidden when keys are unlocked but their trusted workspace copy is missing", async () => {
  state.required.mockResolvedValue(true); state.keys = true; state.inventory = true;
  render(<PrivateWorkspaceBoundary userId="owner"><Draft /></PrivateWorkspaceBoundary>);
  await screen.findByText("Connect your private workspaces"); expect(screen.queryByText("Private draft 0")).not.toBeInTheDocument(); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(await screen.findByText("Approval request 0")).toBeInTheDocument();
});
