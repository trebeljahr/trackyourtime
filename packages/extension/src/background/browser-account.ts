/** Read the web session only to offer an account and approve a separate extension session. */
import { BRIDGE_TARGET, EXTENSION_CLIENT_ID } from "../lib/config";
import { CLIENT_HEADER } from "@starter/core";
import type { WebAccount } from "../lib/web-account";

const TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Matches the build's narrowly scoped cookie/host permissions. */
export function canReadBrowserAccount(apiUrl: string): boolean {
  try {
    const url = new URL(apiUrl);
    if (url.origin === "https://api.trackyourtime.dev") {
      return BRIDGE_TARGET === "production" || BRIDGE_TARGET === "development";
    }
    return BRIDGE_TARGET === "development" && url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch { return false; }
}

export type BrowserAccount = { account: WebAccount; token: string };

/** undefined: unavailable on this build/server; null: web is signed out. Never persist token. */
export async function readBrowserAccount(apiUrl: string): Promise<BrowserAccount | null | undefined> {
  if (!canReadBrowserAccount(apiUrl) || typeof chrome.cookies?.getAll !== "function") return undefined;
  const endpoint = `${new URL(apiUrl).origin}/api/auth/get-session`;
  let cookies: chrome.cookies.Cookie[];
  try { cookies = await chrome.cookies.getAll({ url: endpoint }); }
  catch { return undefined; } // The browser may still require this build's site permission.
  for (const cookie of cookies) {
    if (!/(?:^|\.)session_token$/.test(cookie.name) || !cookie.value || cookie.partitionKey) continue;
    const response = await fetch(`${endpoint}?disableCookieCache=true`, {
      headers: { authorization: `Bearer ${cookie.value}`, [CLIENT_HEADER]: EXTENSION_CLIENT_ID },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401) continue;
      throw new Error("Could not check the web account.");
    }
    const body = await response.json() as {
      user?: { id?: unknown; email?: unknown; image?: unknown };
      session?: { createdAt?: unknown };
    } | null;
    const user = body?.user;
    const created = body?.session?.createdAt;
    const sessionCreatedAt = typeof created === "number" || typeof created === "string" ? new Date(created).getTime() : NaN;
    if (!user || typeof user.id !== "string" || !user.id || typeof user.email !== "string" || !user.email || !Number.isFinite(sessionCreatedAt)) continue;
    let image: string | null = null;
    if (typeof user.image === "string" && user.image) {
      try {
        const url = new URL(user.image, apiUrl);
        if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) image = url.href;
      } catch { /* Use the initial when the profile has no valid image. */ }
    }
    return { token: cookie.value, account: { userId: user.id, email: user.email, image, sessionCreatedAt } };
  }
  return null;
}

/** The web cookie authorizes only the claim/approval, never becomes the extension's token. */
export async function approveBrowserDevice(apiUrl: string, token: string, userCode: string): Promise<void> {
  const root = `${new URL(apiUrl).origin}/api/auth`;
  const headers = { authorization: `Bearer ${token}`, [CLIENT_HEADER]: EXTENSION_CLIENT_ID, "content-type": "application/json" };
  const claimed = await fetch(`${root}/device?user_code=${encodeURIComponent(userCode)}`, {
    headers, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!claimed.ok) throw new Error("Could not confirm the web account.");
  const approved = await fetch(`${root}/device/approve`, {
    method: "POST", headers, body: JSON.stringify({ userCode }),
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!approved.ok) throw new Error("Could not approve the extension sign-in.");
}

const avatarCache = new Map<string, string>();

/** Inline first-party images so popup image loading does not depend on a web page or cookies. */
export async function browserAccountImage(apiUrl: string, image: string | null): Promise<string | null> {
  if (!image) return null;
  let url: URL;
  try { url = new URL(image, apiUrl); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.origin !== new URL(apiUrl).origin || !url.pathname.startsWith("/api/avatars/")) return url.href;
  const cached = avatarCache.get(url.href);
  if (cached) return cached;
  try {
    const response = await fetch(url.href, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const mime = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || !mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) return url.href;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return url.href;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const data = `data:${mime};base64,${btoa(binary)}`;
    if (avatarCache.size >= 8) avatarCache.clear();
    avatarCache.set(url.href, data);
    return data;
  } catch { return url.href; }
}


let lastOffer: { apiUrl: string; until: number; account: WebAccount | null | undefined } | null = null;

/** A bridge update can make the cached cookie lookup stale before its five seconds expire. */
export function clearBrowserAccountOfferCache(): void {
  lastOffer = null;
}

/** Polling the popup refreshes offers without fetching the web session every second. */
export async function discoverBrowserAccount(apiUrl: string): Promise<WebAccount | null | undefined> {
  if (lastOffer?.apiUrl === apiUrl && lastOffer.until > Date.now()) return lastOffer.account;
  const browser = await readBrowserAccount(apiUrl);
  const account = browser ? browser.account : browser;
  lastOffer = { apiUrl, until: Date.now() + 5_000, account };
  return account;
}
