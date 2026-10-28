import { createPrivateDeviceReceiver, encryptPrivateDeviceApproval } from "@starter/core";
import { privateDeviceTransferSchema, type PrivateDeviceTransfer, type PrivateDeviceInvite, type PrivateIdentity } from "@starter/shared";
import { assertIdentityKeys, checkedPrivateSession, installVerifiedPrivateSession, privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion } from "./private-session";
import { getChosenWebUrl } from "./api-origin";
import { isTokenShell } from "./shell";
import { capturePrivateDeviceWorkspaceTrust, restorePrivateDeviceWorkspaceTrust } from "./private-device-workspace-trust";
import { privateRoutingRequired, requirePrivateRouting } from "./private-routing-requirement";
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
  if (!target && !isTokenShell() && typeof window !== "undefined") {
    const page = new URL(window.location.origin);
    if (page.protocol === "https:" || (page.protocol === "http:" && loopback(page))) target = page.origin;
  }
  if (!target && process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    const page = new URL(window.location.origin);
    if (["http:", "https:"].includes(page.protocol) && loopback(api) && loopback(page)) target = page.origin;
  }
  if (!target) throw new PrivateDeviceWebOriginError();
  const web = new URL(target);
  if (web.username || web.password || (web.protocol !== "https:" && !(web.protocol === "http:" && loopback(web)))) throw new PrivateDeviceWebOriginError();
  return web.origin;
}

/** Private keys leave the browser only in the receiving app's encrypted box.
 * The confirmation code is displayed locally; never include it in an API call. */
export async function sealPrivateDeviceUnlock(userId: string, invite: PrivateDeviceInvite, identity: PrivateIdentity) {
  const assertCurrent = privateOperationScope(userId);
  if (invite.server !== privateDataOrigin() || invite.userId !== userId) throw new Error("This request belongs to another server or account");
  const current = checkedPrivateSession(userId, identity);
  const workspaceTrust = await capturePrivateDeviceWorkspaceTrust(userId); assertCurrent();
  if (privateSession(userId) !== current) throw new Error("Private data is locked");
  const value = privateDeviceTransferSchema.parse({ v: workspaceTrust && "timer" in workspaceTrust ? 3 : 2, server: invite.server, userId, keys: { publicKey: identity.publicKey, signingPublicKey: identity.signingPublicKey }, secrets: current, workspaceTrust });
  const result = await encryptPrivateDeviceApproval(invite, value);
  assertCurrent(); if (privateSession(userId) !== current) throw new Error("Private data is locked");
  return result;
}
export async function createPrivateDeviceUnlock(userId: string) {
  const assertCurrent = privateOperationScope(userId), server = privateDataOrigin(), version = privateSessionVersion();
  let canceled = false, expiresAt = Number.POSITIVE_INFINITY;
  const waiting = () => { assertCurrent(); if (canceled || privateSessionVersion() !== version) throw new Error("Private-device unlock changed during this request"); if (Date.now() >= expiresAt) throw new Error("Private-device unlock expired during this request"); };
  const receiver = await createPrivateDeviceReceiver<PrivateDeviceTransfer>({ server, userId });
  expiresAt = receiver.invite.expiresAt;
  try { waiting(); } catch (error) { receiver.cancel(); throw error; }
  return {
    invite: receiver.invite,
    async accept(box: unknown) { waiting(); await receiver.accept(box); waiting(); },
    async confirm(code: string) {
      waiting();
      const value = privateDeviceTransferSchema.parse(receiver.confirm(code));
      if (value.server !== server || value.userId !== userId) throw new Error("Invalid private identity transfer");
      assertIdentityKeys(value.keys, value.secrets);
      if (value.workspaceTrust) {
        await requirePrivateRouting({ server, userId }, () => { try { waiting(); return true; } catch { return false; } }); waiting();
        // Restore with confirmation-authenticated temporary keys. Publishing a
        // session first could let an old standard policy leak private filters.
        await restorePrivateDeviceWorkspaceTrust(userId, value.workspaceTrust, { server, secrets: value.secrets, check: waiting }); waiting();
      } else {
        const required = await privateRoutingRequired({ server, userId }); waiting(); if (required) throw new Error("This account needs its trusted workspace checkpoint before unlocking this device");
        await requirePrivateRouting({ server, userId }, () => { try { waiting(); return true; } catch { return false; } }); waiting();
      }
      installVerifiedPrivateSession(userId, value.keys, value.secrets);
    },
    cancel: () => { canceled = true; receiver.cancel(); },
  };
}
