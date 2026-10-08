import type { Db, Document } from "mongodb";
import type { Migration } from "./types.js";

/**
 * How close to the person's own `createdAt` a workspace must have been created
 * to count as the one the signup hook made. The hook runs inside the signup
 * request, so in practice it is milliseconds; a minute leaves room for a slow
 * database without catching a workspace made by hand later the same day.
 */
export const SIGNUP_WINDOW_MS = 60_000;

/** The raw collections, named as better-auth and mongoose name them. */
const ORGANIZATIONS = "organization";
const AUTH_MEMBERS = "member";
const USERS = "user";
const WORKSPACE_MEMBERS = "workspacemembers";

/**
 * Ids as strings. better-auth stores its ids and references as ObjectIds,
 * `WorkspaceMember` stores plain strings; comparing either needs one form.
 */
const idOf = (value: unknown): string | null => {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object" && "toHexString" in value) return String(value);
  return null;
};

const timeOf = (value: unknown): number => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

type Org = { raw: Document["_id"]; id: string; createdAt: number; kind: unknown };

/**
 * Pick the personal workspace of one person among the workspaces they own
 * alone. Exported for the unit test of the rule itself.
 *
 * The one the signup hook made (created within {@link SIGNUP_WINDOW_MS} of the
 * account) wins; failing that — the hook failed and the read path repaired it
 * later — the oldest. Never a workspace with anybody else in it: a signup
 * workspace a colleague was already invited into stays a team workspace,
 * because marking it personal would lock that colleague into a workspace the
 * rest of the app then treats as private.
 */
export function choosePersonalWorkspace(
  userCreatedAt: number,
  candidates: readonly { id: string; createdAt: number }[],
): string | null {
  const byAge = [...candidates].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const signup = byAge.find((org) => Math.abs(org.createdAt - userCreatedAt) <= SIGNUP_WINDOW_MS);
  return (signup ?? byAge[0])?.id ?? null;
}

/**
 * Marks every existing workspace with its kind: each person's signup
 * workspace `personal`, every other one `team`.
 *
 * Additive — older builds never read `kind` — so `minReaderSchema` stays 0.
 *
 * Idempotent, and safe to cut off anywhere: a workspace that already has a
 * kind is never rewritten, a person who already has a personal workspace is
 * skipped, and the "everything else is a team" sweep runs only after every
 * person has had their pick, so a re-run after a crash between the two
 * passes picks up exactly where it stopped.
 */
export const personalWorkspaces: Migration = {
  id: 2,
  description: "workspace kind: mark each person's signup workspace personal, every other one team",
  minReaderSchema: 0,
  up: async (db: Db) => {
    const orgs = new Map<string, Org>();
    for (const doc of await db
      .collection(ORGANIZATIONS)
      .find({}, { projection: { _id: 1, createdAt: 1, kind: 1 } })
      .toArray()) {
      const id = idOf(doc._id);
      if (id) orgs.set(id, { raw: doc._id, id, createdAt: timeOf(doc.createdAt), kind: doc.kind });
    }

    // Who is in each workspace, counted from BOTH records: the mirror grants
    // access, and a `member` row with no mirror is a half-finished add that a
    // retry would complete. Either one makes a workspace not solo.
    const people = new Map<string, Set<string>>();
    const count = (workspaceId: string | null, userId: string | null): void => {
      if (!workspaceId || !userId) return;
      const set = people.get(workspaceId) ?? new Set<string>();
      set.add(userId);
      people.set(workspaceId, set);
    };
    const ownedBy = new Map<string, string[]>();
    for (const row of await db
      .collection(WORKSPACE_MEMBERS)
      .find({}, { projection: { workspaceId: 1, userId: 1, role: 1 } })
      .toArray()) {
      const workspaceId = idOf(row.workspaceId);
      const userId = idOf(row.userId);
      count(workspaceId, userId);
      if (workspaceId && userId && row.role === "owner") {
        ownedBy.set(userId, [...(ownedBy.get(userId) ?? []), workspaceId]);
      }
    }
    for (const row of await db
      .collection(AUTH_MEMBERS)
      .find({}, { projection: { organizationId: 1, userId: 1 } })
      .toArray()) {
      count(idOf(row.organizationId), idOf(row.userId));
    }

    const claimed = new Set<string>();
    for (const user of await db
      .collection(USERS)
      .find({}, { projection: { _id: 1, createdAt: 1 } })
      .toArray()) {
      const userId = idOf(user._id);
      if (!userId) continue;
      const owned = (ownedBy.get(userId) ?? [])
        .map((id) => orgs.get(id))
        .filter((org): org is Org => org !== undefined);
      if (owned.some((org) => org.kind === "personal")) continue;

      const candidates = owned.filter(
        (org) =>
          org.kind === undefined &&
          !claimed.has(org.id) &&
          (people.get(org.id)?.size ?? 0) === 1 &&
          people.get(org.id)?.has(userId) === true,
      );
      const chosen = choosePersonalWorkspace(timeOf(user.createdAt), candidates);
      const org = chosen ? orgs.get(chosen) : undefined;
      if (!org) continue;
      claimed.add(org.id);
      await db
        .collection(ORGANIZATIONS)
        .updateOne({ _id: org.raw, kind: { $exists: false } }, { $set: { kind: "personal" } });
    }

    await db
      .collection(ORGANIZATIONS)
      .updateMany({ kind: { $exists: false } }, { $set: { kind: "team" } });
  },
};
