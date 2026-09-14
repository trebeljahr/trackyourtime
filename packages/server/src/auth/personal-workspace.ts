// Every user gets a personal workspace at signup.
//
// This is the invariant that keeps ownership single-shaped: there is never a
// "user with no workspace" state, so no query, resolver or client ever needs a
// solo-vs-team branch. A solo user simply has a workspace of one.
//
// The workspace IS a better-auth organization — the same id from the very
// first migration, so inviting people into it later never reissues workspace
// ids.
import { randomBytes } from "node:crypto";
import type { WorkspaceRole } from "@starter/shared";
import { WorkspaceMember } from "../models/WorkspaceMember.js";

/** Everything this module needs from a user, so it is trivially testable. */
export type WorkspaceOwner = {
  id: string;
  name?: string | null;
  email?: string | null;
};

/** Minimal surface of `auth.api` used here — keeps the `any` contained. */
type OrgApi = {
  createOrganization: (args: {
    body: { name: string; slug: string; userId: string };
  }) => Promise<{ id?: unknown } | null>;
};

const MAX_SLUG_LENGTH = 48;

/**
 * A slug from the user's email local part, with the user id as the uniqueness
 * tail. Slugs are globally unique across organizations, so a bare "rico" would
 * collide with the second Rico who ever signs up.
 */
export function personalWorkspaceSlug(user: WorkspaceOwner): string {
  const local = (user.email ?? "").split("@")[0] ?? "";
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const tail = user.id.slice(-8).toLowerCase();
  const head = (base || "workspace").slice(0, MAX_SLUG_LENGTH - tail.length - 1);
  return `${head}-${tail}`;
}

/** "Rico's workspace", falling back to the email when there is no name. */
export function personalWorkspaceName(user: WorkspaceOwner): string {
  const who = (user.name ?? "").trim() || (user.email ?? "").split("@")[0] || "My";
  return `${who}'s workspace`;
}

/** How many fresh slugs a creation tries after the deterministic one is taken. */
const SLUG_RETRIES = 3;

/** True for better-auth's "that slug is taken" refusal from createOrganization. */
function isSlugTaken(error: unknown): boolean {
  const body = (error as { body?: { code?: unknown } } | null)?.body;
  return body?.code === "ORGANIZATION_ALREADY_EXISTS";
}

/**
 * The deterministic slug with a random tail, for when that slug is taken.
 *
 * It is taken whenever this person already HAD a personal workspace that is
 * no longer theirs: they handed it over and left it (so they are in no
 * workspace at all), or an earlier creation wrote the organization and died
 * before the mirror. Slugs are global and never freed, so retrying the same
 * one would fail forever — and with it every request that needs a workspace.
 */
export function retrySlug(user: WorkspaceOwner): string {
  const tail = randomBytes(4).toString("hex");
  const base = personalWorkspaceSlug(user).slice(0, MAX_SLUG_LENGTH - tail.length - 1);
  return `${base}-${tail}`;
}

/**
 * Mirror a membership into the app-owned collection.
 *
 * better-auth's `member` row is written by the plugin; this is the sibling
 * record that carries the things the plugin does not model — the billing rate
 * and the two visibility flags.
 *
 * The flag rule is the one every membership write follows
 * (`services/membership/lifecycle.ts`): an owner sees everything, always —
 * forced on, on insert AND on update — while anybody else opens CLOSED. An
 * admin used to open with both flags on; being able to manage people is not
 * the same grant as reading their rates, so no role but owner is ever given a
 * flag by a role write.
 */
export async function upsertWorkspaceMember(args: {
  workspaceId: string;
  user: WorkspaceOwner;
  role: WorkspaceRole;
}): Promise<void> {
  const owner = args.role === "owner";
  const name = args.user.name ?? args.user.email ?? "";
  await WorkspaceMember.updateOne(
    { workspaceId: args.workspaceId, userId: args.user.id },
    owner
      ? {
          $set: { role: args.role, name, canViewOthersTime: true, canViewOthersMoney: true },
          $setOnInsert: {
            workspaceId: args.workspaceId,
            userId: args.user.id,
            hourlyRate: null,
          },
        }
      : {
          $set: { role: args.role, name },
          $setOnInsert: {
            workspaceId: args.workspaceId,
            userId: args.user.id,
            hourlyRate: null,
            canViewOthersTime: false,
            canViewOthersMoney: false,
          },
        },
    { upsert: true },
  );
}

/**
 * Create the personal workspace for a freshly created user and mirror the
 * membership. Returns the new workspace id, or null when creation failed.
 *
 * Never throws: a signup must not fail because the workspace could not be
 * created. `ensurePersonalWorkspace` on the read path repairs the gap for any
 * user that slips through (including every user that predates this hook).
 */
export async function createPersonalWorkspace(
  api: OrgApi,
  user: WorkspaceOwner,
): Promise<string | null> {
  try {
    let organization: { id?: unknown } | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        organization = await api.createOrganization({
          body: {
            name: personalWorkspaceName(user),
            slug: attempt === 0 ? personalWorkspaceSlug(user) : retrySlug(user),
            userId: user.id,
          },
        });
        break;
      } catch (error) {
        if (!isSlugTaken(error) || attempt >= SLUG_RETRIES) throw error;
      }
    }

    const workspaceId = organization?.id ? String(organization.id) : null;
    if (!workspaceId) return null;

    await upsertWorkspaceMember({ workspaceId, user, role: "owner" });
    return workspaceId;
  } catch (error) {
    console.error("[auth] could not create personal workspace", error);
    return null;
  }
}
