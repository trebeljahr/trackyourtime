// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createKeyPair, createSigningPair, decodeSecret, privateMemberKeyFingerprint, type PublicKey } from "@starter/core";
type Root = { privateKey: PublicKey; signingPrivateKey: PublicKey };
const state = vi.hoisted(() => ({ version: 0, root: null as Root | null, origin: "https://api.example.test", account: "owner", listeners: new Set<() => void>(), hash: vi.fn() }));
vi.mock("@/lib/private-session", () => ({
  privateSession: (id: string) => id === state.account ? state.root : null,
  privateDataOrigin: () => state.origin,
  privateSessionVersion: () => state.version,
  subscribePrivateSession: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
  privateOperationScope: (id: string) => { const version = state.version, origin = state.origin; return () => { if (version !== state.version || origin !== state.origin || id !== state.account) throw new Error("Stale private session"); }; },
}));
vi.mock("@starter/core", async () => {
  const actual = await vi.importActual<typeof import("@starter/core")>("@starter/core");
  return { ...actual, privateMemberKeyFingerprint: (...args: Parameters<typeof actual.privateMemberKeyFingerprint>) => state.hash(...args) };
});
const { PrivateKeyCode } = await import("./private-key-code");
const changed = () => { state.version++; for (const fn of state.listeners) fn(); };
const coordinates = ({ kty, crv, x, y }: PublicKey) => ({ kty, crv, x, y });
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); state.version = 0; state.account = "owner"; state.origin = "https://api.example.test";
  state.root = { privateKey: (await createKeyPair()).privateKey, signingPrivateKey: (await createSigningPair()).privateKey };
  state.hash.mockReset().mockImplementation((await vi.importActual<typeof import("@starter/core")>("@starter/core")).privateMemberKeyFingerprint);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows an account/server-bound code from both unlocked local keys, passing no private fields", async () => {
  render(<PrivateKeyCode userId="owner" />);
  const output = await screen.findByLabelText("Your key verification code");
  const call = state.hash.mock.calls[0]!;
  expect(call).toEqual([state.origin, { userId: "owner", publicKey: coordinates(state.root!.privateKey), signingPublicKey: coordinates(state.root!.signingPrivateKey) }]);
  expect(JSON.stringify(call)).not.toContain(state.root!.privateKey.d!);
  expect(JSON.stringify(call)).not.toContain(state.root!.signingPrivateKey.d!);
  const expected = await (await vi.importActual<typeof import("@starter/core")>("@starter/core")).privateMemberKeyFingerprint(...call as Parameters<typeof privateMemberKeyFingerprint>);
  expect(output.textContent?.replaceAll(" ", "")).toBe(Array.from(decodeSecret(expected, 32), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase());
  expect(screen.getByText(/Keep your recovery key private/)).toBeTruthy();
});
it("immediately clears the old code on lock and refuses a late hash result", async () => {
  let finish!: (value: string) => void;
  state.hash.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  render(<PrivateKeyCode userId="owner" />);
  await waitFor(() => expect(state.hash).toHaveBeenCalledTimes(1));
  act(() => { state.root = null; changed(); });
  await act(async () => finish("a".repeat(64)));
  expect(screen.queryByLabelText("Your key verification code")).toBeNull();
  expect(screen.getByText(/Unlock your private data to see/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
it("does not show the previous account's code after an account/server change", async () => {
  const { rerender } = render(<PrivateKeyCode userId="owner" />);
  await screen.findByLabelText("Your key verification code");
  act(() => { state.account = "other"; state.origin = "https://another.example.test"; state.root = null; changed(); });
  rerender(<PrivateKeyCode userId="other" />);
  expect(screen.queryByLabelText("Your key verification code")).toBeNull();
});
