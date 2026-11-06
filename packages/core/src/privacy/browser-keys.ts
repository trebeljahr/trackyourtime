/**
 * Account keys delivered by the browser that approves a sign-in
 * (docs/private-workspace-protocol.md → "Browser sign-in delivers the keys").
 *
 * A client that signs in through the browser (Raycast, the extension, the
 * desktop app, a CLI) makes a one-time receiving key pair and a 32-byte
 * pairing secret, and puts the public half and the secret in the approval
 * URL's fragment. Fragments never reach a server. The browser seals the
 * account keys to that public key and adds a tag derived from the pairing
 * secret; the server relays the sealed box (privacy.createDeviceUnlock /
 * approveDeviceUnlock) without being able to read it, and cannot make a box
 * of its own that the client accepts, because it never saw the secret.
 *
 * No zod here: Raycast vendors this file (packages/raycast/scripts/vendor-core.mjs).
 */
import type { PrivateDeviceApproval } from "@starter/shared";
import { canonicalJson, createKeyPair, decodeSecret, deriveSecret, encodeSecret, randomSecret, sealForRecipient, unsealForRecipient, type PublicKey, type RecipientBox } from "./crypto.js";

/** The relay keeps a request this long (`PRIVATE_DEVICE_TTL_MS` in shared). */
export const BROWSER_KEYS_TTL_MS = 5 * 60 * 1000;
const FRAGMENT_KEY = "keys";
const encoder = new TextEncoder();

/** What travels in the fragment: public material and the pairing secret. */
export type BrowserKeyRequest = {
  v: 1;
  requestId: string;
  server: string;
  publicKey: PublicKey;
  expiresAt: number;
  secret: string;
};

export class BrowserKeysError extends Error {
  constructor(message: string) { super(message); this.name = "BrowserKeysError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9_-]+$/;

function publicOnly(key: PublicKey): PublicKey {
  if (!key || key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string" || !B64.test(key.x) || !B64.test(key.y) || key.x.length > 64 || key.y.length > 64) throw new BrowserKeysError("Invalid receiving key");
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y };
}

function checkRequest(value: unknown, now: () => number): BrowserKeyRequest {
  const request = value as BrowserKeyRequest;
  if (!request || typeof request !== "object" || request.v !== 1 || typeof request.requestId !== "string" || !UUID.test(request.requestId)) throw new BrowserKeysError("Invalid key request");
  if (typeof request.server !== "string" || request.server.length > 2048) throw new BrowserKeysError("Invalid key request");
  const server = new URL(request.server);
  if (!["http:", "https:"].includes(server.protocol) || server.origin !== request.server) throw new BrowserKeysError("Invalid key request");
  if (typeof request.expiresAt !== "number" || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now() || request.expiresAt > now() + BROWSER_KEYS_TTL_MS + 60_000) throw new BrowserKeysError("This key request has expired");
  if (typeof request.secret !== "string" || !B64.test(request.secret) || decodeSecret(request.secret, 32).length !== 32) throw new BrowserKeysError("Invalid key request");
  return { v: 1, requestId: request.requestId, server: request.server, publicKey: publicOnly(request.publicKey), expiresAt: request.expiresAt, secret: request.secret };
}

/** Bound into every box: the account only the browser knows at sealing time. */
const binding = (request: BrowserKeyRequest, userId: string) => canonicalJson({
  protocol: "trackyourtime-browser-keys-v1",
  request: { requestId: request.requestId, server: request.server, publicKey: request.publicKey, expiresAt: request.expiresAt },
  userId,
});

async function pairingTag(request: BrowserKeyRequest, userId: string): Promise<string> {
  const secret = decodeSecret(request.secret, 32);
  try { return encodeSecret(await deriveSecret(secret, `pairing:${binding(request, userId)}`)); }
  finally { secret.fill(0); }
}

/** The approval URL with the request in its fragment. */
export function browserKeysUrl(approvalUrl: string, request: BrowserKeyRequest): string {
  const url = new URL(approvalUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new BrowserKeysError("Invalid approval address");
  url.hash = `${FRAGMENT_KEY}=${encodeSecret(encoder.encode(JSON.stringify(request)))}`;
  return url.href;
}

/** The browser's side: the request in a page's fragment, or null when there is none. */
export function browserKeyRequestFromHash(hash: string, now = Date.now): BrowserKeyRequest | null {
  const encoded = new URLSearchParams(hash.replace(/^#/, "")).get(FRAGMENT_KEY);
  if (!encoded) return null;
  return checkRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeSecret(encoded, 4096))), now);
}

/** The browser's side: seal `value` (the account keys) for the requesting client. */
export async function sealBrowserKeys(requestValue: BrowserKeyRequest, userId: string, value: unknown, now = Date.now): Promise<PrivateDeviceApproval> {
  if (value === undefined) throw new BrowserKeysError("Nothing to deliver");
  const request = checkRequest(requestValue, now);
  const pairing = await pairingTag(request, userId);
  const box = await sealForRecipient(request.publicKey, { v: 1, value, pairing }, binding(request, userId));
  checkRequest(request, now);
  return box as PrivateDeviceApproval;
}

export type BrowserKeyReceiver<T> = {
  request: BrowserKeyRequest;
  /** Open the relayed box for `userId`, the account the sign-in returned. Once. */
  open: (userId: string, approval: unknown) => Promise<T>;
  cancel: () => void;
};

/** The client's side: a fresh request, kept in memory until opened or cancelled. */
export async function createBrowserKeyReceiver<T>(server: string, now = Date.now): Promise<BrowserKeyReceiver<T>> {
  const pair = await createKeyPair();
  const secret = randomSecret();
  const request = checkRequest({ v: 1, requestId: crypto.randomUUID(), server: new URL(server).origin, publicKey: pair.publicKey, expiresAt: now() + BROWSER_KEYS_TTL_MS, secret: encodeSecret(secret) }, now);
  secret.fill(0);
  let active = true;
  const cancel = () => { active = false; pair.privateKey.d = ""; request.secret = ""; };
  return {
    request,
    async open(userId, approval) {
      if (!active) throw new BrowserKeysError("This key request is closed");
      try {
        checkRequest(request, now);
        if (typeof userId !== "string" || !userId) throw new BrowserKeysError("Unknown account");
        const expected = await pairingTag(request, userId);
        const payload = await unsealForRecipient<{ v: number; value: T; pairing: string }>(pair.privateKey, approval as RecipientBox, binding(request, userId));
        if (payload?.v !== 1 || !Object.hasOwn(payload, "value") || payload.pairing !== expected) throw new BrowserKeysError("These keys did not come from the browser that approved the sign-in");
        return payload.value;
      } finally { cancel(); }
    },
    cancel,
  };
}
