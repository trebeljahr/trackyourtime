/** A short-lived account offer, stored in memory across service-worker restarts. */
import { sameServerOrigin } from "@starter/core";
import { decodeExtensionBridgeRequest, extensionBridgeSyncRequest } from "@starter/shared/extension-bridge";
import { chromeStorage, sessionStorageArea } from "./chrome-storage";

export type WebAccount = {
  userId: string;
  email: string;
  image: string | null;
  sessionCreatedAt: number;
};

const KEY = "trackyourtime.web-account";
export const WEB_ACCOUNT_TTL_MS = 90_000;
const storage = () => chromeStorage(sessionStorageArea());

export async function saveWebAccount(apiOrigin: string, account: WebAccount | null, now = Date.now()): Promise<void> {
  if (account === null) return storage().removeItem(KEY);
  const request = extensionBridgeSyncRequest(apiOrigin, {
    userId: account.userId,
    sessionCreatedAt: account.sessionCreatedAt,
    profile: { email: account.email, image: account.image },
  });
  await storage().setItem(KEY, JSON.stringify({ request, seenAt: now }));
}

export async function loadWebAccount(apiOrigin: string, now = Date.now()): Promise<WebAccount | null> {
  const raw = await storage().getItem(KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const saved = parsed as Record<string, unknown>;
    if (
      typeof saved.seenAt !== "number" || !Number.isFinite(saved.seenAt) ||
      saved.seenAt > now || now - saved.seenAt > WEB_ACCOUNT_TTL_MS
    ) return null;
    const decoded = decodeExtensionBridgeRequest(saved.request);
    if (!decoded.ok || decoded.message.kind !== "sync") return null;
    if (!sameServerOrigin(decoded.message.apiOrigin, apiOrigin)) return null;
    const { web } = decoded.message;
    if (!web.userId || web.sessionCreatedAt === null || !web.profile) return null;
    return { userId: web.userId, sessionCreatedAt: web.sessionCreatedAt, ...web.profile };
  } catch {
    return null;
  }
}
