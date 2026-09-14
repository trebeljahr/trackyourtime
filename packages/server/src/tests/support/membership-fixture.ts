// Two workspaces with people in every role, and recording effects, for the
// membership suites.
//
//   ws-a  "Acme"   olivia (owner) · adam (admin) · mia (member) · max (member)
//   ws-b  "Zeta"   bob (owner) · ben (member)
//
// Member ids are the better-auth `member` row ids, named after the person so a
// failing assertion reads as a sentence.
import type { SyncEvent, WorkspaceRole } from "@starter/shared";
import type { InvitationDeps, InvitationEmail } from "../../services/membership/invitations.js";
import type { MembershipDeps } from "../../services/membership/members.js";
import {
  memoryMembershipStore,
  type MemoryMembershipStore,
} from "./memory-membership-store.js";

export const NOW = new Date("2026-09-14T12:00:00.000Z");

type Person = { id: string; name: string; email: string };

export const PEOPLE = {
  olivia: { id: "u-olivia", name: "Olivia", email: "olivia@acme.test" },
  adam: { id: "u-adam", name: "Adam", email: "adam@acme.test" },
  mia: { id: "u-mia", name: "Mia", email: "mia@acme.test" },
  max: { id: "u-max", name: "Max", email: "max@acme.test" },
  bob: { id: "u-bob", name: "Bob", email: "bob@zeta.test" },
  ben: { id: "u-ben", name: "Ben", email: "ben@zeta.test" },
  newcomer: { id: "u-new", name: "Nina", email: "nina@elsewhere.test" },
} as const satisfies Record<string, Person>;

export type PersonKey = keyof typeof PEOPLE;

const memberships: Array<{ person: PersonKey; workspaceId: string; role: WorkspaceRole; day: number }> = [
  { person: "olivia", workspaceId: "ws-a", role: "owner", day: 1 },
  { person: "adam", workspaceId: "ws-a", role: "admin", day: 2 },
  { person: "mia", workspaceId: "ws-a", role: "member", day: 3 },
  { person: "max", workspaceId: "ws-a", role: "member", day: 4 },
  { person: "bob", workspaceId: "ws-b", role: "owner", day: 1 },
  { person: "ben", workspaceId: "ws-b", role: "member", day: 2 },
];

/** The better-auth member id of a person in a workspace. */
export const memberId = (person: PersonKey, workspaceId: string): string =>
  `m-${person}-${workspaceId}`;

export function seededStore(): MemoryMembershipStore {
  return memoryMembershipStore({
    authUsers: Object.values(PEOPLE).map((p) => ({ ...p })),
    authOrganizations: [
      { id: "ws-a", name: "Acme", slug: "acme" },
      { id: "ws-b", name: "Zeta", slug: "zeta" },
    ],
    authMembers: memberships.map((m) => ({
      id: memberId(m.person, m.workspaceId),
      organizationId: m.workspaceId,
      userId: PEOPLE[m.person].id,
      role: m.role,
      createdAt: new Date(Date.UTC(2026, 0, m.day)),
    })),
    workspaceMembers: memberships.map((m) => ({
      id: `wm-${m.person}-${m.workspaceId}`,
      workspaceId: m.workspaceId,
      userId: PEOPLE[m.person].id,
      role: m.role,
      name: PEOPLE[m.person].name,
      hourlyRate: null,
      canViewOthersTime: m.role === "owner",
      canViewOthersMoney: m.role === "owner",
      createdAt: new Date(Date.UTC(2026, 0, m.day)),
    })),
    authSessions: [
      { id: "s-olivia", userId: PEOPLE.olivia.id, activeOrganizationId: "ws-a" },
      { id: "s-mia", userId: PEOPLE.mia.id, activeOrganizationId: "ws-a" },
      { id: "s-new", userId: PEOPLE.newcomer.id, activeOrganizationId: "ws-new" },
    ],
  });
}

export type Recorded = {
  workspace: Array<{ workspaceId: string; event: SyncEvent }>;
  user: Array<{ userId: string; event: SyncEvent }>;
  stopped: Array<{ userId: string; workspaceId: string }>;
  emails: InvitationEmail[];
  logs: string[];
};

export function recorder(): Recorded {
  return { workspace: [], user: [], stopped: [], emails: [], logs: [] };
}

export function membershipDepsFor(
  store: MemoryMembershipStore,
  recorded: Recorded,
): MembershipDeps {
  return {
    store,
    now: () => NOW,
    stopRunningEntry: async (userId, workspaceId) => {
      recorded.stopped.push({ userId, workspaceId });
    },
    publishWorkspace: (workspaceId, event) => recorded.workspace.push({ workspaceId, event }),
    publishUser: (userId, event) => recorded.user.push({ userId, event }),
    defaultWorkspaceFor: async (user) => `personal-${user.id}`,
  };
}

export function invitationDepsFor(
  store: MemoryMembershipStore,
  recorded: Recorded,
  options: {
    emailConfigured?: boolean;
    sendFails?: boolean;
    budget?: (inviterId: string) => Promise<boolean>;
    now?: () => Date;
  } = {},
): InvitationDeps {
  let n = 0;
  return {
    store,
    now: options.now ?? (() => NOW),
    newId: () => `inv${String(++n).padStart(21, "0")}`,
    frontendUrl: "https://trackyourtime.test/",
    emailConfigured: () => options.emailConfigured ?? false,
    sendInvitationEmail: async (email) => {
      if (options.sendFails) throw new Error("smtp down");
      recorded.emails.push(email);
    },
    log: (message) => recorded.logs.push(message),
    consumeInviteBudget: options.budget ?? (async () => true),
    publishWorkspace: (workspaceId, event) => recorded.workspace.push({ workspaceId, event }),
    publishUser: (userId, event) => recorded.user.push({ userId, event }),
  };
}

/** The acting person, in a workspace, with the role the mirror gives them. */
export function actor(
  store: MemoryMembershipStore,
  person: PersonKey,
  workspaceId: string,
): { userId: string; role: WorkspaceRole; workspaceId: string } {
  const row = store.rows.workspaceMembers.find(
    (r) => r.workspaceId === workspaceId && r.userId === PEOPLE[person].id,
  );
  const role = (row?.role as WorkspaceRole | undefined) ?? "member";
  return { userId: PEOPLE[person].id, role, workspaceId };
}

/** Assert both records agree for one person in one workspace. */
export function recordsOf(
  store: MemoryMembershipStore,
  person: PersonKey,
  workspaceId: string,
): { mirror: Record<string, unknown> | undefined; member: Record<string, unknown> | undefined } {
  const userId = PEOPLE[person].id;
  return {
    mirror: store.rows.workspaceMembers.find(
      (r) => r.workspaceId === workspaceId && r.userId === userId,
    ),
    member: store.rows.authMembers.find(
      (r) => r.organizationId === workspaceId && r.userId === userId,
    ),
  };
}
