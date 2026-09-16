// Settings → Devices. Every signed-in client — the web app, the desktop and
// mobile shells, Raycast, the extensions — is a plain better-auth session, so
// this router is a thin, safe projection over better-auth's own session list.
//
// The one rule that matters here: a session's `token` IS the credential.
// better-auth's `listSessions` returns it, and `revokeSession` takes it, so
// the token is resolved server-side from the client-facing `id` and never
// crosses the wire in either direction.
import { TRPCError } from "@trpc/server";
import {
  revokeDeviceSchema,
  revokeOtherDevicesSchema,
  type ClientKind,
  type DeviceSession,
} from "@starter/shared";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../../auth/auth.js";
import { describeClient, normalizeClientKind } from "../../auth/client-label.js";
import { parseApiLevel, parseClientVersion } from "@starter/shared";
import { publishToUser } from "../../ws/sync.js";
import { protectedProcedure, router } from "../trpc.js";

/** The shape better-auth's `listSessions` yields, narrowed to what we read. */
type RawSession = {
  id: unknown;
  token: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  expiresAt: unknown;
  ipAddress?: unknown;
  userAgent?: unknown;
  client?: unknown;
  clientVersion?: unknown;
  clientApiLevel?: unknown;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asIso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
};

/** Project one raw session into the wire shape. Drops `token` by construction. */
export function toDeviceSession(raw: RawSession, currentToken: string | null): DeviceSession {
  const userAgent = asString(raw.userAgent);
  const client: ClientKind = normalizeClientKind(raw.client);
  const token = asString(raw.token);
  return {
    id: String(raw.id),
    name: describeClient(client, userAgent),
    client,
    userAgent,
    ipAddress: asString(raw.ipAddress),
    createdAt: asIso(raw.createdAt),
    updatedAt: asIso(raw.updatedAt),
    expiresAt: asIso(raw.expiresAt),
    current: token !== null && currentToken !== null && token === currentToken,
    clientVersion: parseClientVersion(raw.clientVersion),
    apiLevel: parseApiLevel(raw.clientApiLevel),
  };
}

/** Read this user's sessions straight from better-auth, tokens included. */
async function listRawSessions(headers: Headers): Promise<RawSession[]> {
  const auth = getAuth();
  const sessions: unknown = await auth.api.listSessions({ headers });
  return Array.isArray(sessions) ? (sessions as RawSession[]) : [];
}

export const devicesRouter = router({
  /**
   * Every device currently signed in as this user, newest first, with the
   * one making the request flagged `current`.
   */
  list: protectedProcedure.query(async ({ ctx }): Promise<DeviceSession[]> => {
    const headers = fromNodeHeaders(ctx.req.headers);
    const raw = await listRawSessions(headers);
    const currentToken = asString(
      (ctx.session as { session?: { token?: unknown } } | null)?.session?.token,
    );

    return raw
      .map((session) => toDeviceSession(session, currentToken))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }),

  /**
   * Sign one device out. Scoped to the caller's own session list, so another
   * user's session id is indistinguishable from one that does not exist.
   */
  revoke: protectedProcedure
    .input(revokeDeviceSchema)
    .mutation(async ({ ctx, input }): Promise<{ id: string }> => {
      const headers = fromNodeHeaders(ctx.req.headers);
      const raw = await listRawSessions(headers);

      const match = raw.find((session) => String(session.id) === input.id);
      const token = match ? asString(match.token) : null;
      if (!token) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      }

      await getAuth().api.revokeSession({ headers, body: { token } });

      publishToUser(ctx.user.id, { kind: "settings.changed" }, input.originId);
      return { id: input.id };
    }),

  /** Sign out everywhere except here — the "I lost my laptop" button. */
  revokeOthers: protectedProcedure
    .input(revokeOtherDevicesSchema)
    .mutation(async ({ ctx, input }): Promise<{ revoked: number }> => {
      const headers = fromNodeHeaders(ctx.req.headers);
      const before = await listRawSessions(headers);

      await getAuth().api.revokeOtherSessions({ headers });

      publishToUser(ctx.user.id, { kind: "settings.changed" }, input.originId);
      return { revoked: Math.max(0, before.length - 1) };
    }),
});
