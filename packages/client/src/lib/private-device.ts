import { createPrivateDeviceReceiver, encryptPrivateDeviceApproval } from "@starter/core";
import { privateIdentitySchema, type PrivateDeviceInvite, type PrivateIdentity } from "@starter/shared";
import { checkedPrivateSession, installVerifiedPrivateSession, privateDataOrigin, privateOperationScope, privateSession, type UnlockedIdentity } from "./private-session";
import { getChosenWebUrl } from "./api-origin";
export class PrivateDeviceWebOriginError extends Error {
  constructor() { super("Choose a trusted browser address for this server before browser unlocking"); this.name = "PrivateDeviceWebOriginError"; }
}
const loopback = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
/** The API relays ciphertext; it must not also choose new executable browser
 * code for an existing device. Use the saved server choice, a build setting,
 * or the hosted app's known address. Local development stays on its own page. */
export function privateDeviceWebOrigin(): string {
  const selected = getChosenWebUrl() || process.env.NEXT_PUBLIC_WEB_URL;
  const api = new URL(privateDataOrigin());
  let target = selected || (api.origin === "https://api.trackyourtime.dev" ? "https://trackyourtime.dev" : null);
  if (!target && process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    const page = new URL(window.location.origin);
    if (["http:", "https:"].includes(page.protocol) && loopback(api) && loopback(page)) target = page.origin;
  }
  if (!target) throw new PrivateDeviceWebOriginError();
  const web = new URL(target);
  if (web.username || web.password || (web.protocol !== "https:" && !(web.protocol === "http:" && loopback(web)))) throw new PrivateDeviceWebOriginError();
  return web.origin;
}
type TransferredIdentity = {
  v: 1; server: string; userId: string;
  keys: Pick<PrivateIdentity, "publicKey" | "signingPublicKey">;
  secrets: UnlockedIdentity;
};
const publicKeys = privateIdentitySchema.pick({ publicKey: true, signingPublicKey: true });

/** Private keys leave the browser only in the receiving app's encrypted box.
 * The confirmation code is displayed locally; never include it in an API call. */
export async function sealPrivateDeviceUnlock(userId: string, invite: PrivateDeviceInvite, identity: PrivateIdentity) {
  const assertCurrent = privateOperationScope(userId);
  if (invite.server !== privateDataOrigin() || invite.userId !== userId) throw new Error("This request belongs to another server or account");
  const current = checkedPrivateSession(userId, identity);
  const value: TransferredIdentity = { v: 1, server: invite.server, userId, keys: { publicKey: identity.publicKey, signingPublicKey: identity.signingPublicKey }, secrets: current };
  const result = await encryptPrivateDeviceApproval(invite, value);
  assertCurrent(); if (privateSession(userId) !== current) throw new Error("Private data is locked");
  return result;
}
export async function createPrivateDeviceUnlock(userId: string) {
  const assertCurrent = privateOperationScope(userId), server = privateDataOrigin();
  const receiver = await createPrivateDeviceReceiver<TransferredIdentity>({ server, userId });
  try { assertCurrent(); } catch (error) { receiver.cancel(); throw error; }
  return {
    invite: receiver.invite,
    async accept(box: unknown) { assertCurrent(); await receiver.accept(box); assertCurrent(); },
    confirm(code: string) {
      assertCurrent();
      const value = receiver.confirm(code);
      if (value?.v !== 1 || value.server !== server || value.userId !== userId) throw new Error("Invalid private identity transfer");
      const keys = publicKeys.parse(value.keys);
      installVerifiedPrivateSession(userId, keys, value.secrets);
    },
    cancel: receiver.cancel,
  };
}
