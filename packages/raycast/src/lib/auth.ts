import { LocalStorage } from "@raycast/api";
import {
  createId,
  sameServerOrigin,
  signOutSession,
  type IssuedSession,
} from "@starter/core";
import { clearCache } from "./local-cache.js";
import { clearEveryOverlay } from "./overlay.js";
import { apiUrl } from "./preferences.js";

/**
 * Where the session token lives.
 *
 * Raycast's `LocalStorage` is an encrypted, per-extension store — no other
 * extension can read it, and it never lands in a plain config file. That is
 * the right home for a better-auth session token: it is a bearer credential,
 * so anyone holding it is the user until it is revoked from Settings →
 * Devices.
 */
const TOKEN_KEY = "trackyourtime.session.token";
const EMAIL_KEY = "trackyourtime.session.email";
const USER_KEY = "trackyourtime.session.userId";
/**
 * The server that issued the token. A token is a credential for ONE server:
 * after the API URL preference is pointed somewhere else, sending it along
 * would hand this account's session to a server that has no business holding
 * it. So a token is only ever used against the origin stored beside it.
 */
const SERVER_KEY = "trackyourtime.session.server";
const ORIGIN_KEY = "trackyourtime.originId";

/** Names this client in Settings → Devices, and in the device flow. */
export const CLIENT_ID = "trackyourtime-raycast" as const;

export type StoredSession = {
  token: string;
  email: string | null;
  /**
   * The account this token belongs to.
   *
   * Null on a session stored by a build that predates offline queueing, and on
   * one the server issued without a user id. Every queued mutation is stamped
   * with it, so it is read far more often than it is shown — see
   * `lib/offline.ts` for why a queue that outlives a sign-out needs it.
   */
  userId: string | null;
};

/**
 * The origin the stored token belongs to, claiming the current one for a token
 * stored before this was recorded — the preference has not changed since that
 * build last ran, so that is the server that issued it.
 */
async function storedServer(): Promise<string | null> {
  const token = await LocalStorage.getItem<string>(TOKEN_KEY);
  if (!token) return null;
  const server = await LocalStorage.getItem<string>(SERVER_KEY);
  if (server) return server;
  await LocalStorage.setItem(SERVER_KEY, apiUrl());
  return apiUrl();
}

/** True when a token is stored and it was issued by the server in use now. */
async function sessionIsForThisServer(): Promise<boolean> {
  const server = await storedServer();
  return server !== null && sameServerOrigin(server, apiUrl());
}

export async function getStoredSession(): Promise<StoredSession | null> {
  // A token from another server reads as signed out here: the person signs in
  // to the server they pointed Raycast at, and the old token is never sent.
  if (!(await sessionIsForThisServer())) return null;
  const token = await LocalStorage.getItem<string>(TOKEN_KEY);
  if (!token) return null;
  const email = await LocalStorage.getItem<string>(EMAIL_KEY);
  const userId = await LocalStorage.getItem<string>(USER_KEY);
  return { token, email: email ?? null, userId: userId ?? null };
}

/**
 * Who this Mac is signed in as, for stamping queued work.
 *
 * A read of local storage, so it answers with the network down — which is the
 * only moment it matters.
 */
export async function getStoredUserId(): Promise<string | null> {
  if (!(await sessionIsForThisServer())) return null;
  return (await LocalStorage.getItem<string>(USER_KEY)) ?? null;
}

export async function storeSession(session: IssuedSession): Promise<void> {
  await LocalStorage.setItem(TOKEN_KEY, session.token);
  if (session.email) await LocalStorage.setItem(EMAIL_KEY, session.email);
  else await LocalStorage.removeItem(EMAIL_KEY);
  if (session.userId) await LocalStorage.setItem(USER_KEY, session.userId);
  else await LocalStorage.removeItem(USER_KEY);
  await LocalStorage.setItem(SERVER_KEY, apiUrl());
}

/**
 * Forget the local token, and tell the server to drop the session too.
 *
 * The remote call is best effort: what actually protects the user is that the
 * token stops existing on this machine, so a failed round trip must not stop
 * that from happening.
 */
export async function signOut(): Promise<void> {
  const token = await LocalStorage.getItem<string>(TOKEN_KEY);
  const server = await storedServer();
  if (token && server) {
    // Revoked where it was issued — which, after the API URL preference has
    // moved, is not the server every other call now goes to.
    await signOutSession({ baseUrl: server, clientId: CLIENT_ID }, token);
  }
  await LocalStorage.removeItem(TOKEN_KEY);
  await LocalStorage.removeItem(EMAIL_KEY);
  await LocalStorage.removeItem(USER_KEY);
  await LocalStorage.removeItem(SERVER_KEY);

  // The cached reads and the optimistic overlay both describe one account's
  // workspace, so they go — the next person to pair must not see the last
  // one's projects and entries painted from storage before the first fetch
  // lands.
  //
  // The QUEUE deliberately stays, unlike the browser extension's, which
  // clears its own on sign-out. Its rows are the only copy of time this Mac
  // tracked with no signal, and every one of them is stamped with the account
  // that made them, so the next person to pair can neither replay them nor
  // read them — the timer surfaces only say how many there are and whose they
  // are not. Signing back in picks them up.
  //
  // Both are per workspace, and every workspace's copy goes. The workspace
  // choice itself stays: it is stamped with this account, so the next account
  // cannot read it, and the names in it are what describe this account's held
  // rows when it signs back in.
  await clearCache();
  await clearEveryOverlay();
}

/**
 * Stable per-install id sent with every mutation, so the sync WebSocket can
 * tell "a change this client made" from "a change another client made" and
 * the web app does not double-apply our own writes.
 */
export async function getOriginId(): Promise<string> {
  const existing = await LocalStorage.getItem<string>(ORIGIN_KEY);
  if (existing) return existing;
  const created = `raycast-${createId()}`;
  await LocalStorage.setItem(ORIGIN_KEY, created);
  return created;
}
