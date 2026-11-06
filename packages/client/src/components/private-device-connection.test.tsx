// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { encryptPrivateDeviceApproval, privateDeviceInviteFromHash, privateInventoryVersionRoot, privateRecordDigest } from "@starter/core";
import { API_LEVEL } from "@starter/shared";
import { privateRecoveryFixture } from "@/test-private-recovery";
const state = vi.hoisted(() => ({ create: vi.fn(), poll: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/api-origin", () => ({ getApiOrigin: () => "https://api.example.test", getChosenWebUrl: () => "https://app.example.test", subscribeApiOrigin: () => () => {}, whenApiOriginReady: async () => {} }));
vi.mock("@/lib/desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("@/lib/server-level", () => ({ currentServerApiLevel: () => API_LEVEL }));
vi.mock("@/lib/native-session", () => ({ getNativeToken: () => null }));
vi.mock("@/lib/shell", () => ({ clientId: () => "web", isCapacitor: () => false, isElectron: () => false, isTokenShell: () => false }));
vi.mock("@/lib/app-version", () => ({ APP_VERSION: "test" }));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => {} }));
vi.mock("./settings/private-data", () => ({ PrivateDataCard: () => <p>Existing key controls</p> }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: {
  createDeviceUnlock: { useMutation: () => ({ mutateAsync: state.create }) }, deviceUnlockStatus: { useMutation: () => ({ mutateAsync: state.poll }) }, cancelDeviceUnlock: { useMutation: () => ({ mutateAsync: state.cancel }) },
} } }));
const session = await import("@/lib/private-session");
const { requirePrivateRouting } = await import("@/lib/private-routing-requirement");
const { PrivateWorkspaceBoundary } = await import("./private-workspace-boundary");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); session.lockPrivateData(); session.privateAccountChanged("owner"); state.create.mockReset().mockResolvedValue({}); state.poll.mockReset(); state.cancel.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("connects a new browser through real code confirmation without cancelling itself during marker/checkpoint writes", async () => {
  const f = await privateRecoveryFixture(), version = f.archive.inventory.pending[0]!, root = await privateInventoryVersionRoot(version);
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.example.test/api/trpc/privacy.inventoryVersions"); expect(init?.method).toBe("POST"); expect(init?.cache).toBe("no-store"); expect(String(init?.body)).not.toMatch(/master|privateKey|Unsent/);
    return new Response(JSON.stringify({ result: { data: { through: 1, root, next: null, versions: [version] } } }), { headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher); const popup = vi.spyOn(window, "open");
  let deliver!: (value: unknown) => void; state.poll.mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
  const cancellations: boolean[] = []; state.cancel.mockImplementation(async () => { cancellations.push(session.privateSession("owner") !== null); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A device that already knows this account is private (an unknown device now enrolls in standard storage by itself).
  await requirePrivateRouting({ server: "https://api.example.test", userId: "owner" }, () => true);
  const view = render(<QueryClientProvider client={client}><PrivateWorkspaceBoundary userId="owner"><p>Private workspace form</p></PrivateWorkspaceBoundary></QueryClientProvider>);
  await screen.findByText("Unlock private workspace data"); expect(screen.queryByText("Private workspace form")).not.toBeInTheDocument(); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByText("Get approval from a trusted device"));
  const link = await screen.findByLabelText("Approval link for your trusted device") as HTMLInputElement;
  await waitFor(() => expect(state.poll).toHaveBeenCalledOnce()); expect(popup).not.toHaveBeenCalled();
  const invite = privateDeviceInviteFromHash(new URL(link.value).hash);
  const response = await encryptPrivateDeviceApproval(invite, { v: 2, server: invite.server, userId: "owner", keys: { publicKey: f.identity.publicKey, signingPublicKey: f.identity.signingPublicKey }, secrets: f.secrets,
    workspaceTrust: { inventory: { revision: 1, digest: await privateRecordDigest(f.enrollment.inventory) }, transport: { revision: 1, root } } });
  await act(async () => { deliver({ box: response.approval }); });
  fireEvent.change(await screen.findByLabelText("8-character code from your browser"), { target: { value: response.code } });
  fireEvent.click(screen.getByText("Confirm and unlock"));
  await screen.findByText("Private workspace form"); expect(session.privateSession("owner")).toEqual(f.secrets); expect(fetcher).toHaveBeenCalledOnce(); expect(cancellations.every(Boolean)).toBe(true);
  view.unmount(); client.clear();
});
