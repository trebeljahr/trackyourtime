// The membership lifecycle, as writes to both records.
//
// Every operation here writes better-auth's `member` AND the app's
// `WorkspaceMember`, in an order chosen so that a crash between the two writes
// leaves the SAFE disagreement, and so that calling the same operation again
// finishes the job. There is no progress marker to get out of sync — each
// write is an idempotent update or delete by filter, or an insert guarded by
// a read.
//
// The ordering rule, once: `WorkspaceMember` is what grants access (the app
// authorizes from nothing else), `member` is what a retry uses to find the
// person again. So access is granted LAST and revoked FIRST:
//
//   add     member ──► WorkspaceMember        crash between = not yet in
//   remove  WorkspaceMember ──► member        crash between = already out
//
// Both intermediate states are "a `member` row with no mirror", which the app
// reads as "no access", and both are finished by running the operation again.
//
// Permission checks are NOT here — `members.ts` and `invitations.ts` decide
// whether an actor may do something. These functions only keep the records
// honest, so the invariants they own (owner flags forced on, exact role
// strings, never zero owners during a transfer) hold for every caller,
// including the ones that have already been authorized.
import type { WorkspaceRole } from "@starter/shared";
import { isWorkspaceRole } from "@starter/shared";
import { ensureOwner } from "./records.js";
import {
  DuplicateRowError,
  type MembershipRowStore,
} from "./store.js";

/** A role that is not exactly one of the three strings. */
export class InvalidRoleError extends Error {
  constructor(value: unknown) {
    super(`membership: invalid role ${JSON.stringify(value)}`);
    this.name = "InvalidRoleError";
  }
}

/** Ownership handed to somebody with no `WorkspaceMember` row. */
export class TransferTargetNotMemberError extends Error {
  constructor() {
    super("membership: ownership can only go to a current member");
    this.name = "TransferTargetNotMemberError";
  }
}

/**
 * Refuse anything but the exact role strings.
 *
 * better-auth reads "admin,owner" as both roles; the input schemas already
 * refuse it, and this is the second line, so no caller of the lifecycle can
 * store one.
 */
export function assertRole(value: unknown): WorkspaceRole {
  if (!isWorkspaceRole(value)) throw new InvalidRoleError(value);
  return value;
}

/**
 * The flags a membership opens with.
 *
 * An owner sees everything, always. Everybody else starts CLOSED — seeing
 * only their own time — and is opened up by a deliberate edit. An invited
 * admin is no exception: being able to manage people is not the same grant as
 * being able to read their rates.
 */
export function initialFlags(role: WorkspaceRole): {
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
} {
  const owner = role === "owner";
  return { canViewOthersTime: owner, canViewOthersMoney: owner };
}

/**
 * Put a person into a workspace.
 *
 * `member` first, `WorkspaceMember` last. Idempotent: a person who already
 * has a mirror row keeps the role they have — accepting the same invitation
 * twice, or an invitation for a role lower than one already held, never
 * changes it.
 */
export async function addMember(
  store: MembershipRowStore,
  args: {
    workspaceId: string;
    userId: string;
    name: string;
    role: WorkspaceRole;
    now: Date;
  },
): Promise<void> {
  const role = assertRole(args.role);
  const { workspaceId, userId } = args;

  const app = await store.find("workspaceMembers", { workspaceId, userId });
  if (app.length > 0) return;

  const auth = await store.find("authMembers", { organizationId: workspaceId, userId });
  if (auth.length === 0) {
    await store.insertOne("authMembers", {
      organizationId: workspaceId,
      userId,
      role,
      createdAt: args.now,
    });
  } else if (auth.some((row) => row.role !== role)) {
    // A `member` row with no mirror is a half-finished add or a half-finished
    // removal. Either way the mirror about to be written decides the role, so
    // the plugin's record is brought to the same value first.
    await store.updateMany("authMembers", { organizationId: workspaceId, userId }, { role });
  }

  try {
    await store.insertOne("workspaceMembers", {
      workspaceId,
      userId,
      role,
      name: args.name.slice(0, 200),
      hourlyRate: null,
      ...initialFlags(role),
      createdAt: args.now,
      updatedAt: args.now,
    });
  } catch (error) {
    // Two accepts racing: the unique index let exactly one of them in, and
    // that one is the membership. Nothing to do.
    if (!(error instanceof DuplicateRowError)) throw error;
  }
}

/**
 * Take a person out of a workspace. Their entries and history stay — that
 * time was tracked for the workspace.
 *
 * `WorkspaceMember` first: from that write on, their API tokens, webhook
 * deliveries, sync fan-out and every tRPC call into this workspace answer as
 * if they were never in it. Then any timer they have running HERE is stopped
 * (it would otherwise keep counting in a workspace they cannot reach), and the
 * `member` row goes last, because it is what a retry finds them by.
 */
export async function removeMembership(
  store: MembershipRowStore,
  args: {
    workspaceId: string;
    userId: string;
    stopRunningEntry: (userId: string, workspaceId: string) => Promise<void>;
  },
): Promise<void> {
  const { workspaceId, userId } = args;
  await store.deleteMany("workspaceMembers", { workspaceId, userId });
  await args.stopRunningEntry(userId, workspaceId);
  await store.deleteMany("authMembers", { organizationId: workspaceId, userId });
}

/**
 * Set a person's role in both records.
 *
 * Promotion to owner goes through `ensureOwner`, which also forces both flags
 * on. Any other role leaves the flags exactly as they are: stepping an owner
 * down to admin does not quietly close what they could see, and making
 * somebody an admin does not quietly open it.
 */
export async function setRole(
  store: MembershipRowStore,
  args: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<void> {
  const role = assertRole(args.role);
  const { workspaceId, userId } = args;
  if (role === "owner") {
    await ensureOwner(store, workspaceId, userId);
    return;
  }
  // Mirror first: a demotion takes effect where access is decided before the
  // plugin's record catches up.
  await store.updateMany("workspaceMembers", { workspaceId, userId }, { role });
  await store.updateMany("authMembers", { organizationId: workspaceId, userId }, { role });
}

/**
 * Change the two visibility flags. Only the mirror carries them.
 *
 * An owner's flags are not editable: they are forced on, and a request to
 * close them is answered by writing them open again rather than by storing a
 * state the rest of the app assumes cannot exist.
 */
export async function setVisibility(
  store: MembershipRowStore,
  args: {
    workspaceId: string;
    userId: string;
    canViewOthersTime?: boolean;
    canViewOthersMoney?: boolean;
  },
): Promise<void> {
  const { workspaceId, userId } = args;
  const [row] = await store.find("workspaceMembers", { workspaceId, userId });
  if (!row) return;
  if (row.role === "owner") {
    await store.updateMany(
      "workspaceMembers",
      { workspaceId, userId },
      { canViewOthersTime: true, canViewOthersMoney: true },
    );
    return;
  }
  const set: Record<string, boolean> = {};
  if (args.canViewOthersTime !== undefined) set.canViewOthersTime = args.canViewOthersTime;
  if (args.canViewOthersMoney !== undefined) set.canViewOthersMoney = args.canViewOthersMoney;
  if (Object.keys(set).length === 0) return;
  await store.updateMany("workspaceMembers", { workspaceId, userId }, set);
}

/**
 * Hand a workspace from one owner to another member.
 *
 * Promote FIRST, in both records, then step the previous owner down to admin
 * (flags unchanged). A crash anywhere leaves two owners, never none, and
 * running the transfer again finishes it: the promotion is a no-op the second
 * time and the demotion simply happens.
 *
 * The demotion writes better-auth's `member` BEFORE the mirror — the reverse
 * of `setRole`. The person retrying a half-finished transfer is the previous
 * owner, and the middleware reads their role from the mirror: had the mirror
 * been demoted first, a crash would leave them an admin who can no longer call
 * transfer, beside a `member` row still saying owner that nothing would ever
 * finish. Mirror last keeps them an owner until the very last write.
 */
export async function transferOwnership(
  store: MembershipRowStore,
  args: { workspaceId: string; fromUserId: string; toUserId: string },
): Promise<void> {
  const { workspaceId, fromUserId, toUserId } = args;
  if (fromUserId === toUserId) return;
  // The mirror is what makes somebody an owner the app acts on. Promoting a
  // person who has none (a removal a crash cut in half) would write "owner"
  // onto a `member` row nothing reads, and the demotion below would then
  // leave the workspace with no owner at all.
  const target = await store.find("workspaceMembers", { workspaceId, userId: toUserId });
  if (target.length === 0) throw new TransferTargetNotMemberError();
  await ensureOwner(store, workspaceId, toUserId);
  await store.updateMany(
    "authMembers",
    { organizationId: workspaceId, userId: fromUserId },
    { role: "admin" },
  );
  await store.updateMany(
    "workspaceMembers",
    { workspaceId, userId: fromUserId },
    { role: "admin" },
  );
}
