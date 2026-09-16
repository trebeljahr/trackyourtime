// The version handshake, server side: what a request declares about the
// client that sent it, the floor below which it is refused, and the version
// recorded on its session for Settings → Devices.
//
// Like the client kind in `client-label.ts`, a declared version is
// self-reported. It labels a row and decides the floor refusal — a refusal the
// caller can always avoid by lying, which is fine: the floor protects honest
// old clients from a server they would misread, not the server from anyone.
import {
  API_LEVEL_HEADER,
  CLIENT_TOO_OLD,
  CLIENT_VERSION_HEADER,
  MIN_CLIENT_API_LEVEL,
  compareVersions,
  parseApiLevel,
  parseClientVersion,
  type VersionRefusal,
} from "@starter/shared";

export type DeclaredClient = {
  clientVersion: string | null;
  apiLevel: number | null;
};

/** Something headers can be read from: a Fetch `Headers` or Node's plain object. */
export type HeaderSource =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | null
  | undefined;

const readHeader = (headers: HeaderSource, name: string): string | undefined => {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const value = (headers as Readonly<Record<string, string | readonly string[] | undefined>>)[name];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
};

/** The version and API level a request declared, each null when absent. */
export function declaredClient(headers: HeaderSource): DeclaredClient {
  try {
    return {
      clientVersion: parseClientVersion(readHeader(headers, CLIENT_VERSION_HEADER)),
      apiLevel: parseApiLevel(readHeader(headers, API_LEVEL_HEADER)),
    };
  } catch {
    return { clientVersion: null, apiLevel: null };
  }
}

/**
 * `CLIENT_TOO_OLD` when the request declared an API level below
 * `MIN_CLIENT_API_LEVEL`, otherwise null.
 *
 * A request that declares NO level is a client from before the handshake and
 * is always served: the floor exists to refuse clients that can say how old
 * they are, never to lock out ones that cannot.
 */
export function versionRefusalFor(
  headers: HeaderSource,
  floor: number = MIN_CLIENT_API_LEVEL,
): VersionRefusal | null {
  const { apiLevel } = declaredClient(headers);
  if (apiLevel === null) return null;
  return apiLevel < floor ? CLIENT_TOO_OLD : null;
}

/** What a refused client is told. The same words on tRPC and REST. */
export const CLIENT_TOO_OLD_MESSAGE =
  "This version of the app is too old for this server. Update the app to keep syncing; nothing stored on this device has been deleted.";

/**
 * The session fields a new session gets from the request creating it. Only
 * declared values are returned, so an undeclared one is left absent on the row
 * rather than written as null.
 */
export function versionFieldsForNewSession(
  headers: HeaderSource,
): { clientVersion?: string; clientApiLevel?: number } {
  const { clientVersion, apiLevel } = declaredClient(headers);
  return {
    ...(clientVersion !== null ? { clientVersion } : {}),
    ...(apiLevel !== null ? { clientApiLevel: apiLevel } : {}),
  };
}

/**
 * The update to write when a request uses an existing session, or null.
 *
 * Only ever forward: a newer release, or the same release at a higher level.
 * A web session is one cookie shared by every open tab, and a tab left open
 * across an upgrade would otherwise flip the row back and forth on each
 * request. A request that declares no version never writes.
 */
export function versionUpdateForSession(
  stored: { clientVersion?: unknown; clientApiLevel?: unknown },
  declared: DeclaredClient,
): { clientVersion: string; clientApiLevel?: number } | null {
  if (declared.clientVersion === null) return null;
  const storedVersion = parseClientVersion(stored.clientVersion);
  const storedLevel = parseApiLevel(stored.clientApiLevel);
  const update = {
    clientVersion: declared.clientVersion,
    ...(declared.apiLevel !== null ? { clientApiLevel: declared.apiLevel } : {}),
  };
  if (storedVersion === null) return update;
  const order = compareVersions(declared.clientVersion, storedVersion);
  if (order > 0) return update;
  if (order < 0) return null;
  if (declared.apiLevel !== null && (storedLevel === null || declared.apiLevel > storedLevel)) {
    return update;
  }
  return null;
}

/**
 * Sessions this process already brought up to date, by session id.
 *
 * The session a request carries can come from better-auth's five-minute
 * cookie cache, still showing the version from before the update — without
 * this, every request in that window would write the same value again.
 * Bounded, because it is a cache of writes skipped, not a record of anything.
 */
const recorded = new Map<string, string>();
const MAX_RECORDED = 10_000;

const recordKey = (update: { clientVersion: string; clientApiLevel?: number }): string =>
  `${update.clientVersion}@${update.clientApiLevel ?? ""}`;

export type SessionVersionWriter = (
  sessionToken: string,
  update: { clientVersion: string; clientApiLevel?: number },
) => Promise<unknown>;

/**
 * Bring a session's recorded version forward when a newer client uses it.
 *
 * Fire-and-forget by design: a failed write costs a stale label in Settings →
 * Devices and must never fail the request that triggered it.
 */
export function recordSessionClientVersion(
  session: { id?: unknown; token?: unknown; clientVersion?: unknown; clientApiLevel?: unknown } | null | undefined,
  headers: HeaderSource,
  write: SessionVersionWriter,
): Promise<boolean> {
  if (!session || typeof session.id !== "string" || typeof session.token !== "string") {
    return Promise.resolve(false);
  }
  const update = versionUpdateForSession(session, declaredClient(headers));
  if (update === null) return Promise.resolve(false);
  const key = recordKey(update);
  if (recorded.get(session.id) === key) return Promise.resolve(false);
  if (recorded.size >= MAX_RECORDED) recorded.clear();
  recorded.set(session.id, key);
  const sessionId = session.id;
  return write(session.token, update).then(
    () => true,
    () => {
      recorded.delete(sessionId);
      return false;
    },
  );
}
