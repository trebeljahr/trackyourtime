// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ required: vi.fn(), keys: false, version: 0, routing: 0, epoch: "0", listeners: new Set<() => void>(), signOut: vi.fn() }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => state.keys ? {} : null, privateSessionVersion: () => state.version, subscribePrivateSession: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@/lib/private-routing-requirement", () => ({ privateRoutingRequired: state.required, privateRoutingRevision: () => state.routing, subscribePrivateRoutingRequirement: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@/lib/private-view-lifecycle", () => ({ privateViewEpoch: () => state.epoch, subscribePrivateViewEpoch: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("@/lib/api-origin", () => ({ whenApiOriginReady: async () => {} }));
vi.mock("@/lib/auth-client", () => ({ signOut: state.signOut }));
vi.mock("./startup-screen", () => ({ StartupScreen: () => <p>Checking device</p> }));
vi.mock("./settings/private-data", () => ({ PrivateDataCard: ({ unlockOnly }: { unlockOnly?: boolean }) => <p data-testid="unlock-controls">{unlockOnly ? "Existing keys only" : "May create keys"}</p> }));
const { PrivateWorkspaceBoundary } = await import("./private-workspace-boundary");
beforeEach(() => { state.required.mockReset(); state.required.mockResolvedValue(false); state.keys = false; state.version = 0; state.routing = 0; state.epoch = "0"; });
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
