import { PRIVATE_DEVICE_TTL_MS, privateDeviceApprovalSchema, privateDeviceInviteSchema, type PrivateDeviceApproval, type PrivateDeviceInvite } from "@starter/shared";
import { canonicalJson, createKeyPair, decodeSecret, encodeSecret, randomSecret, sealForRecipient, unsealForRecipient } from "./crypto.js";
const encoder = new TextEncoder();
export class PrivateDeviceCodeError extends Error {
  constructor(readonly closed: boolean) { super("Device confirmation code did not match"); this.name = "PrivateDeviceCodeError"; }
}
const binding = (invite: PrivateDeviceInvite) => canonicalJson({ protocol: "trackyourtime-private-device-v1", invite });
function checkInvite(value: unknown, now: () => number): PrivateDeviceInvite {
  const invite = privateDeviceInviteSchema.parse(value), server = new URL(invite.server);
  if (!["http:", "https:"].includes(server.protocol) || server.origin !== invite.server || invite.expiresAt <= now() || invite.expiresAt > now() + PRIVATE_DEVICE_TTL_MS + 60_000) throw new Error("Invalid or expired private-device request");
  return invite;
}
async function confirmationCode(invite: PrivateDeviceInvite, secret: string): Promise<string> {
  if (decodeSecret(secret, 32).length !== 32) throw new Error("Invalid device confirmation secret");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${binding(invite)}:${secret}`)));
  return Array.from(hash.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
/** The invite contains only public material and can travel in a URL fragment.
 * The encrypted payload's random confirmation secret never goes to the relay
 * in plaintext. The browser displays its derived code; the native app requires
 * that code before releasing the payload. A relay can deny delivery, but cannot
 * silently substitute a different identity under this confirmation step. */
export async function encryptPrivateDeviceApproval<T>(inviteValue: unknown, value: T, now = Date.now): Promise<{ approval: PrivateDeviceApproval; code: string }> {
  if (value === undefined) throw new Error("Missing private-device approval value");
  const invite = checkInvite(inviteValue, now), secret = randomSecret();
  try {
    const confirmation = encodeSecret(secret);
    const approval = privateDeviceApprovalSchema.parse(await sealForRecipient(invite.publicKey, { v: 1, value, confirmation }, binding(invite)));
    const code = await confirmationCode(invite, confirmation);
    checkInvite(invite, now);
    return { approval, code };
  } finally { secret.fill(0); }
}
export type PrivateDeviceReceiver<T> = {
  invite: PrivateDeviceInvite;
  accept: (approval: unknown) => Promise<void>;
  confirm: (code: string) => T;
  cancel: () => void;
};
export async function createPrivateDeviceReceiver<T>(scope: { server: string; userId: string }, now = Date.now): Promise<PrivateDeviceReceiver<T>> {
  const pair = await createKeyPair();
  const invite = checkInvite({ v: 1, requestId: crypto.randomUUID(), server: scope.server, userId: scope.userId, publicKey: pair.publicKey, expiresAt: now() + PRIVATE_DEVICE_TTL_MS }, now);
  if (invite.publicKey.key_ops) Object.freeze(invite.publicKey.key_ops);
  Object.freeze(invite.publicKey); Object.freeze(invite);
  let active = true, attempted = false, attempts = 0;
  let candidate: { code: string; value: T } | null = null;
  const cancel = () => { active = false; candidate = null; pair.privateKey.d = ""; };
  const check = () => {
    if (!active) throw new Error("Private-device request is closed");
    try { checkInvite(invite, now); } catch (error) { cancel(); throw error; }
  };
  return {
    invite,
    async accept(value) {
      check();
      // Accept one candidate only: a relay cannot adaptively guess the short
      // confirmation code through repeated substitutions on one request.
      if (attempted) throw new Error("A device response has already been received");
      attempted = true;
      try {
        const approval = privateDeviceApprovalSchema.parse(value);
        const payload = await unsealForRecipient<{ v: number; value: T; confirmation: string }>(pair.privateKey, approval, binding(invite));
        if (payload?.v !== 1 || !Object.hasOwn(payload, "value") || typeof payload.confirmation !== "string") throw new Error("Invalid private-device response");
        const code = await confirmationCode(invite, payload.confirmation); check();
        candidate = { code, value: payload.value };
      } catch (error) { cancel(); throw error; }
    },
    confirm(input) {
      check();
      if (!candidate) throw new Error("Private-device approval has not arrived");
      const code = input.replace(/\s/g, "").toUpperCase();
      if (!/^[0-9A-F]{8}$/.test(code) || code !== candidate.code) {
        if (++attempts >= 3) cancel();
        throw new PrivateDeviceCodeError(!active);
      }
      const value = candidate.value; cancel(); return value;
    },
    cancel,
  };
}
export function privateDeviceUrl(webUrl: string, invite: PrivateDeviceInvite): string {
  privateDeviceInviteSchema.parse(invite);
  const url = new URL("/private-device/", webUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid private-device web origin");
  url.hash = `invite=${encodeSecret(encoder.encode(JSON.stringify(invite)))}`;
  return url.href;
}
export function privateDeviceInviteFromHash(hash: string, now = Date.now): PrivateDeviceInvite {
  const encoded = new URLSearchParams(hash.replace(/^#/, "")).get("invite");
  if (!encoded) throw new Error("Missing private-device request");
  return checkInvite(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeSecret(encoded, 4096))), now);
}
