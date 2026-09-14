// better-auth's organization endpoints, closed to HTTP.
//
// The plugin stays installed: it owns the `organization`, `member` and
// `invitation` tables, the session's `activeOrganizationId`, and
// `auth.api.createOrganization`, which the signup hook uses to create every
// personal workspace. What it must not do is take requests. Its endpoints
// write only its own tables and never the app's `WorkspaceMember` — the one
// record tracktime authorizes from — so every one of them reachable over HTTP
// was a way around the membership rules:
//
//  - `update-member-role` accepts comma-joined roles ("admin,owner"), which
//    the plugin reads as both: an admin could make themselves an owner;
//  - `accept-invitation`, `remove-member`, `leave` and `delete` change who is
//    in a workspace while the mirror goes on saying otherwise — a removed
//    person keeps their API tokens, webhooks and sync, a deleted
//    organization leaves orphaned memberships;
//  - `create` + `set-active` point a session at a workspace with no mirror;
//  - every refusal is a 403 or 400, which confirms a foreign id exists.
//
// So: any `/organization/*` path that arrived as a real HTTP request answers
// 404, exactly what an endpoint that was never mounted answers. Membership
// is driven through tRPC (`trpc/routers/{workspaces,members,invitations}.ts`),
// which writes both records and applies the permission matrix.
//
// Server-side `auth.api.*` calls carry no `request` and still pass — that is
// how `createPersonalWorkspace` keeps working. It is the same test
// `recordDeletionPassword` uses to tell the two apart.
import { APIError, createAuthMiddleware } from "better-auth/api";
import { recordDeletionPassword } from "../../auth/account-deletion.js";
import { INVITATION_TTL_SECONDS } from "./invitations.js";

const ORGANIZATION_PREFIX = "/organization/";

/** The part of a better-auth hook context this check reads. */
export type HookContextLike = { path?: string; request?: unknown };

/** True for a plugin organization endpoint reached over HTTP. */
export function isOrganizationHttpRequest(ctx: HookContextLike): boolean {
  return (
    typeof ctx.path === "string" &&
    ctx.path.startsWith(ORGANIZATION_PREFIX) &&
    ctx.request !== undefined &&
    ctx.request !== null
  );
}

/** better-auth `hooks.before` step: answer 404 to organization endpoints over HTTP. */
export function refuseOrganizationHttp(ctx: HookContextLike): void {
  if (isOrganizationHttpRequest(ctx)) throw new APIError("NOT_FOUND");
}

/**
 * The instance's one `hooks.before`, so each step is a plain call in a fixed
 * order — and so the integration test runs exactly what `auth/auth.ts` wires
 * in rather than a copy of it:
 *
 *  1. `/organization/*` over HTTP answers 404 (above).
 *  2. `/delete-user` remembers whether a password was sent
 *     (`auth/account-deletion.ts`). Called as a middleware: better-call
 *     rebuilds its context from this one, keeping `path`, `body` and
 *     `request`, which is all that step reads.
 */
export const authBeforeHook = createAuthMiddleware(async (ctx) => {
  refuseOrganizationHttp(ctx);
  await recordDeletionPassword(ctx);
});

/**
 * The organization plugin's options, shared with the integration test for
 * the same reason as the hook.
 */
export const organizationPluginOptions = {
  // Personal workspaces are created for their owner by the signup hook, so
  // the creator is always "owner".
  creatorRole: "owner",
  // Refused even server-side: deleting an organization would orphan every
  // `WorkspaceMember` row and all of the workspace's data. Account deletion
  // removes a workspace nobody else uses, row by row.
  disableOrganizationDeletion: true,
  // The lifetime `invitations.ts` stamps on the rows it writes, stated here
  // too so the plugin's own reading of those rows agrees.
  invitationExpiresIn: INVITATION_TTL_SECONDS,
} as const;
