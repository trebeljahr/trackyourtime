import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { getAuth } from "../auth/auth.js";
import { fromNodeHeaders } from "better-auth/node";

/**
 * How the caller proved who they are:
 *  - "cookie" — browser session cookie (web app, desktop and mobile shells
 *               that run in a webview with cookies)
 *  - "bearer" — the same better-auth session, carried as
 *               `Authorization: Bearer <token>` by Raycast, the extensions
 *               and any other non-cookie client
 *  - null     — anonymous
 *
 * Both are the *same* session record — there is no second credential type.
 * The distinction is kept only for logging and debugging.
 */
export type AuthMethod = "cookie" | "bearer" | null;

/**
 * Build the tRPC request context.
 *
 * There is exactly one auth path: a better-auth session. The `bearer` plugin
 * turns an `Authorization: Bearer <session-token>` header into that same
 * session before `getSession()` looks it up, so cookie clients and token
 * clients converge here with identical `session`/`user` shapes.
 */
function readActiveWorkspaceId(session: unknown): string | null {
  const value = (session as { session?: { activeOrganizationId?: unknown } })
    ?.session?.activeOrganizationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The session row's id — what `workspaces.setActive` writes through. */
function readSessionId(session: unknown): string | null {
  const value = (session as { session?: { id?: unknown } })?.session?.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function createContext({ req, res }: CreateExpressContextOptions) {
  const auth = getAuth();
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (session?.user) {
    const usedBearer = /^Bearer\s+\S/i.test(req.headers.authorization ?? "");
    return {
      req,
      res,
      session,
      user: session.user,
      authMethod: (usedBearer ? "bearer" : "cookie") satisfies AuthMethod,
      /**
       * The workspace this session last switched to, written by
       * `workspaces.setActive` (the plugin's own set-active is closed). It
       * is only ever a DEFAULT — an explicit `workspaceId` on a procedure's
       * input wins, because a long-lived client (Raycast, the extension)
       * cannot be relied on to have re-read this. A stale value, pointing at
       * a workspace the person has since left, falls back to their oldest
       * membership. See auth/workspace.ts.
       */
      activeWorkspaceId: readActiveWorkspaceId(session),
      sessionId: readSessionId(session),
    };
  }

  return {
    req,
    res,
    session: null,
    user: null,
    authMethod: null satisfies AuthMethod,
    activeWorkspaceId: null,
    sessionId: null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
