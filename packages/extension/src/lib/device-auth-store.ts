/**
 * The device authorization the extension is waiting on, if any.
 *
 * An MV3 service worker is stopped after about thirty idle seconds, and a
 * `setTimeout` poll loop dies with it — so the pending authorization is kept
 * in `chrome.storage.session`, and whatever wakes the worker next (the web
 * app's `device-approved`, the alarm, the popup opening) makes one token
 * exchange against it. Session storage, like the token itself: the device code
 * is a credential until it is spent, and it dies with the browser.
 *
 * Beside it, two small facts that must survive the same restarts: when the
 * last authorization failed (the bridge backs off after that), and why the
 * last one the popup started did not finish.
 *
 * Only the service worker touches these. The popup sees the user code and the
 * expiry on the snapshot — never the device code.
 */
import { sameServerOrigin } from "@starter/core";
import { chromeStorage, sessionStorageArea } from "./chrome-storage";

/** The alarm that keeps a popup-started device sign-in going across worker stops. */
export const DEVICE_AUTH_ALARM = "trackyourtime.device-auth-poll";

export const PENDING_DEVICE_AUTH_KEY = "trackyourtime.pending-device-auth";
export const DEVICE_AUTH_FAILED_AT_KEY = "trackyourtime.device-auth-failed-at";
export const DEVICE_AUTH_ERROR_KEY = "trackyourtime.device-auth-error";

/**
 * Who started the authorization.
 *
 * - `web-link`: the bridge, for a person signed in to the web app. The page
 *   approves it; `forUserId` is who the page said was signed in, and the
 *   issued session must belong to exactly that user.
 * - `manual`: the popup's "Sign in with the web app". The person approves it
 *   in a tab, as whoever they are signed in as there.
 */
export type DeviceAuthPurpose = "web-link" | "manual";

export type PendingDeviceAuth = {
  /** Handed to the page with the code, and echoed back in `device-approved`. */
  requestId: string;
  deviceCode: string;
  userCode: string;
  /** The API origin the authorization was started against. */
  apiOrigin: string;
  purpose: DeviceAuthPurpose;
  /** For `web-link` only: the user the page said was signed in. */
  forUserId: string | null;
  /** Epoch ms. */
  expiresAt: number;
  intervalSeconds: number;
};

/** Why the popup's own device sign-in ended without a session. */
export type DeviceSignInError = "denied" | "expired" | "failed";

const storage = (): ReturnType<typeof chromeStorage> =>
  chromeStorage(sessionStorageArea());

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * A stored value as a pending authorization, or null. Tolerant only in the
 * direction of "none": a record missing anything is no authorization at all,
 * because an exchange with half a record cannot succeed.
 */
export const decodePendingDeviceAuth = (raw: string | null): PendingDeviceAuth | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const requestId = text(record.requestId);
    const deviceCode = text(record.deviceCode);
    const userCode = text(record.userCode);
    const apiOrigin = text(record.apiOrigin);
    const expiresAt = finite(record.expiresAt);
    const intervalSeconds = finite(record.intervalSeconds);
    const purpose = record.purpose;
    if (
      requestId === null ||
      deviceCode === null ||
      userCode === null ||
      apiOrigin === null ||
      expiresAt === null ||
      intervalSeconds === null ||
      (purpose !== "web-link" && purpose !== "manual")
    ) {
      return null;
    }
    const forUserId = text(record.forUserId);
    // A web-link record is only ever adopted for the user it names.
    if (purpose === "web-link" && forUserId === null) return null;
    return {
      requestId,
      deviceCode,
      userCode,
      apiOrigin,
      purpose,
      forUserId: purpose === "web-link" ? forUserId : null,
      expiresAt,
      intervalSeconds: Math.max(1, intervalSeconds),
    };
  } catch {
    return null;
  }
};

export async function savePendingDeviceAuth(record: PendingDeviceAuth): Promise<void> {
  await storage().setItem(PENDING_DEVICE_AUTH_KEY, JSON.stringify(record));
}

export async function loadPendingDeviceAuth(): Promise<PendingDeviceAuth | null> {
  return decodePendingDeviceAuth(await storage().getItem(PENDING_DEVICE_AUTH_KEY));
}

export async function clearPendingDeviceAuth(): Promise<void> {
  await storage().removeItem(PENDING_DEVICE_AUTH_KEY);
}

/** True while `record` can still be exchanged against `apiUrl`. */
export const isLivePendingDeviceAuth = (
  record: PendingDeviceAuth,
  apiUrl: string,
  now: number,
): boolean => record.expiresAt > now && sameServerOrigin(record.apiOrigin, apiUrl);

export async function noteDeviceAuthFailure(at: number): Promise<void> {
  await storage().setItem(DEVICE_AUTH_FAILED_AT_KEY, String(at));
}

export async function loadDeviceAuthFailedAt(): Promise<number | null> {
  const raw = await storage().getItem(DEVICE_AUTH_FAILED_AT_KEY);
  if (raw === null) return null;
  const at = Number(raw);
  return Number.isFinite(at) ? at : null;
}

export async function clearDeviceAuthFailure(): Promise<void> {
  await storage().removeItem(DEVICE_AUTH_FAILED_AT_KEY);
}

export async function saveDeviceSignInError(error: DeviceSignInError): Promise<void> {
  await storage().setItem(DEVICE_AUTH_ERROR_KEY, error);
}

export async function loadDeviceSignInError(): Promise<DeviceSignInError | null> {
  const raw = await storage().getItem(DEVICE_AUTH_ERROR_KEY);
  return raw === "denied" || raw === "expired" || raw === "failed" ? raw : null;
}

export async function clearDeviceSignInError(): Promise<void> {
  await storage().removeItem(DEVICE_AUTH_ERROR_KEY);
}

/** 24 random base64url characters: 144 bits, matching the bridge's request id pattern. */
export const createDeviceRequestId = (): string => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
