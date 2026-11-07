// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as object | null,
  identity: { passkeys: [] as { credentialId: string; envelope: unknown }[] },
  updates: [] as unknown[],
  unlock: vi.fn(),
  opened: vi.fn(),
  add: vi.fn(),
  evaluate: vi.fn(),
}));
vi.mock("@starter/core", async (original) => ({ ...(await original<typeof import("@starter/core")>()), signPrivateChange: async () => "signature" }));
vi.mock("./private-identity-cache", () => ({ rememberPrivateIdentity: async () => ({}) }));
vi.mock("./auth-client", () => ({ authClient: { passkey: { addPasskey: state.add } } }));
vi.mock("./password-unlock", () => ({ openInventoryAndWorkspace: state.opened }));
vi.mock("./private-session", () => ({
  privateSession: () => state.session,
  privateAccountSignedIn: async () => true,
  unlockPrivatePrf: state.unlock,
  evaluatePrivatePasskey: state.evaluate,
  wrapIdentityWithPrf: async (_userId: string, secret: Uint8Array) => ({ sealedWith: secret.length }),
  prfBytes: (value: unknown) => (value instanceof Uint8Array ? value : null),
  PRIVATE_PRF_INPUT: new Uint8Array(1),
}));
vi.mock("./trpc", () => ({ getTRPCClient: () => ({ privacy: {
  identity: { query: async () => ({ identity: state.identity, revision: 4 }) },
  updateIdentity: { mutate: async (input: { identity: typeof state.identity }) => { state.updates.push(input); state.identity = input.identity; } },
} }) }));

const keys = await import("./passkey-keys");
const secret = () => new Uint8Array(32).fill(7);

beforeEach(() => {
  state.session = { signingPrivateKey: {} };
  state.identity = { passkeys: [] };
  state.updates = [];
  for (const fn of [state.unlock, state.opened, state.add, state.evaluate]) fn.mockReset();
});

it("seals the open keys under a new passkey once, in a signed update", async () => {
  expect(await keys.grantPasskey("user-1", "cred-a", secret())).toBe(true);
  expect(await keys.grantPasskey("user-1", "cred-a", secret())).toBe(true);
  expect(state.updates).toHaveLength(1);
  expect(state.identity.passkeys.map((p) => p.credentialId)).toEqual(["cred-a"]);
});

it("adds a passkey and gives it the keys, asking for PRF again when creation reported none", async () => {
  state.add.mockResolvedValue({ data: {}, webauthn: { response: { id: "cred-b" }, clientExtensionResults: {} } });
  state.evaluate.mockResolvedValue({ credentialId: "cred-b", secret: secret() });
  expect(await keys.addPasskeyWithKeys("user-1", "Laptop")).toBe("opens");
  expect(state.evaluate).toHaveBeenCalledWith(["cred-b"]);
  expect(state.identity.passkeys.map((p) => p.credentialId)).toEqual(["cred-b"]);
});

it("says so when the passkey has no PRF, or the keys are locked here", async () => {
  state.add.mockResolvedValue({ data: {}, webauthn: { response: { id: "cred-c" }, clientExtensionResults: {} } });
  state.evaluate.mockRejectedValue(new Error("no prf"));
  expect(await keys.addPasskeyWithKeys("user-1", undefined)).toBe("no-prf");
  state.session = null;
  expect(await keys.addPasskeyWithKeys("user-1", undefined)).toBe("keys-locked");
  expect(state.updates).toHaveLength(0);
});

it("opens the keys with an enrolled passkey on a new device, then rebuilds the workspace list", async () => {
  state.session = null;
  state.identity = { passkeys: [{ credentialId: "cred-d", envelope: {} }] };
  state.unlock.mockImplementation(async () => { state.session = { signingPrivateKey: {} }; });
  await keys.finishPasskeyUnlock("user-1", "cred-d", secret());
  expect(state.unlock).toHaveBeenCalledWith("user-1", state.identity, "cred-d", expect.any(Uint8Array));
  expect(state.opened).toHaveBeenCalledWith("user-1");
});

it("gives an older passkey its copy when it signs in where the keys are already open", async () => {
  await keys.finishPasskeyUnlock("user-1", "cred-e", secret());
  expect(state.unlock).not.toHaveBeenCalled();
  expect(state.identity.passkeys.map((p) => p.credentialId)).toEqual(["cred-e"]);
  expect(state.opened).toHaveBeenCalledWith("user-1");
});

it("drops a removed passkey's copy", async () => {
  state.identity = { passkeys: [{ credentialId: "cred-f", envelope: {} }, { credentialId: "cred-g", envelope: {} }] };
  await keys.revokePasskey("user-1", "cred-f");
  expect(state.identity.passkeys.map((p) => p.credentialId)).toEqual(["cred-g"]);
});
