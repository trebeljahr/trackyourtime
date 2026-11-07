/**
 * The browser half of "Browser sign-in delivers the keys"
 * (docs/private-workspace-protocol.md; the client half is
 * `startBrowserSignIn` in core).
 *
 * A client that signs in through `/app/device/?user_code=…` puts a one-time
 * key request in the URL fragment. The fragment never reaches a server, but a
 * signed-out visitor is sent to /login first and the fragment would be lost on
 * the way, so it is moved into this tab's sessionStorage at once and removed
 * from the address bar. After the sign-in is approved, the account keys are
 * sealed for that request and relayed through the server, which cannot read
 * them or make a box the client would accept.
 */
import { browserKeyRequestFromHash, decodeBrowserKeyRequest, sealBrowserKeys, type BrowserKeyRequest } from "@starter/core";

const STORAGE_KEY = "trackyourtime:browser-key-request";

/** Move a key request from the address bar into this tab. Call before any redirect. */
export function captureBrowserKeyRequest(): void {
  if (typeof window === "undefined" || !window.location.hash.includes("keys=")) return;
  try {
    if (browserKeyRequestFromHash(window.location.hash)) sessionStorage.setItem(STORAGE_KEY, window.location.hash);
  } catch { /* An invalid or expired request is dropped. */ }
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

export function pendingBrowserKeyRequest(): BrowserKeyRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    const request = stored ? browserKeyRequestFromHash(stored) : null;
    if (!request) sessionStorage.removeItem(STORAGE_KEY);
    return request;
  } catch {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* nothing stored */ }
    return null;
  }
}

export function forgetBrowserKeyRequest(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* nothing stored */ }
}

export type PreparedBrowserKeys = { userId: string; request: BrowserKeyRequest };

/**
 * Before approving the sign-in: open the relay slot, so the client, once it
 * has its token, can tell "keys are coming" from "no keys". Null when this
 * browser cannot send keys (none set up, locked, or another server).
 */
export async function prepareBrowserKeys(userId: string): Promise<PreparedBrowserKeys | null> {
  const request = pendingBrowserKeyRequest();
  return request ? prepareRequest(userId, request) : null;
}

/** The extension bridge's variant: the request came in the `approve-device` reply. */
export async function prepareBrowserKeysFor(userId: string, encoded: string): Promise<PreparedBrowserKeys | null> {
  return prepareRequest(userId, decodeBrowserKeyRequest(encoded));
}

async function prepareRequest(userId: string, request: BrowserKeyRequest): Promise<PreparedBrowserKeys | null> {
  const { privateDataOrigin, privateSession } = await import("./private-session");
  if (request.server !== privateDataOrigin() || !privateSession(userId)) return null;
  const { getTRPCClient } = await import("./trpc");
  await getTRPCClient().privacy.createDeviceUnlock.mutate({ requestId: request.requestId, publicKey: request.publicKey });
  return { userId, request };
}

/** After the sign-in was approved: seal the keys for the client and relay them. */
export async function deliverBrowserKeys({ userId, request }: PreparedBrowserKeys): Promise<void> {
  const { getTRPCClient } = await import("./trpc");
  const client = getTRPCClient();
  try {
    const account = await client.privacy.identity.query({ userId });
    if (!account) throw new Error("This account has no keys");
    const { withPrivateDeviceTransfer } = await import("./private-device");
    const box = await withPrivateDeviceTransfer(userId, account.identity, (value) => sealBrowserKeys(request, userId, value));
    await client.privacy.approveDeviceUnlock.mutate({ requestId: request.requestId, box });
  } catch (error) {
    // Say "no keys" to the client rather than leave it waiting out the request.
    await client.privacy.cancelDeviceUnlock.mutate({ requestId: request.requestId }).catch(() => undefined);
    throw error;
  } finally {
    forgetBrowserKeyRequest();
  }
}
