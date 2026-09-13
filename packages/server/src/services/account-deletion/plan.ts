// What deleting an account removes, as data.
//
// Every step is a `{ collection, filter }` pair rather than a call, for two
// reasons. The filter is where the ownership rule lives — "their entries in a
// shared workspace, but not the invoiced ones" is a Mongo filter, not a branch
// — so it is tested as a filter, against fixture rows. And a list of
// `deleteMany`s is idempotent by construction: a step that already ran matches
// nothing the second time, which is what makes a half-finished deletion safe
// to simply run again.
export {
  planWorkspaceExit,
  type MemberRow,
  type WorkspaceExit,
} from "../membership/records.js";

/**
 * Every collection the cascade touches.
 *
 * The `auth*` names are better-auth's own tables (the organization and device
 * authorization plugins), written through its adapter so ids are converted
 * the way the plugin wrote them. Everything else is an app-owned mongoose
 * model. The user, account and session rows are NOT here: better-auth's
 * `deleteUser` removes those itself, after this cascade has finished.
 */
export type DeletionCollection =
  | "timeEntries"
  | "clients"
  | "projects"
  | "tasks"
  | "tags"
  | "favorites"
  | "invoices"
  | "importBatches"
  | "apiTokens"
  | "webhookSubscriptions"
  | "webhookDeliveries"
  | "workspaceSettings"
  | "businessProfiles"
  | "workspaceMembers"
  | "userPreferences"
  | "profiles"
  | "authOrganizations"
  | "authMembers"
  | "authInvitations"
  | "authDeviceCodes";

export const AUTH_COLLECTIONS: ReadonlySet<DeletionCollection> = new Set([
  "authOrganizations",
  "authMembers",
  "authInvitations",
  "authDeviceCodes",
]);

/**
 * The only filter shapes the cascade uses: equality, `null` (which in Mongo
 * also matches an absent field) and `$in` over string ids. Kept this narrow so
 * the test matcher can model it exactly and the better-auth adapter can
 * translate it without guessing.
 */
export type DeletionFilterValue = string | null | { $in: string[] };
export type DeletionFilter = Readonly<Record<string, DeletionFilterValue>>;

export type DeletionStep = {
  collection: DeletionCollection;
  filter: DeletionFilter;
};

/**
 * Remove a workspace nobody else uses, and everything scoped to it.
 *
 * Order matters for a retry, not for correctness: the membership rows go LAST,
 * because they are how the next attempt finds this workspace again. The
 * organization row goes before them for the same reason — an organization
 * whose members are gone could never be found to be cleaned up.
 */
export function workspaceDeletionSteps(workspaceId: string): DeletionStep[] {
  const scoped = (collection: DeletionCollection): DeletionStep => ({
    collection,
    filter: { workspaceId },
  });
  return [
    scoped("webhookDeliveries"),
    scoped("webhookSubscriptions"),
    scoped("apiTokens"),
    scoped("timeEntries"),
    scoped("favorites"),
    scoped("invoices"),
    scoped("importBatches"),
    scoped("tags"),
    scoped("tasks"),
    scoped("projects"),
    scoped("clients"),
    scoped("workspaceSettings"),
    // The issuer identity printed on the workspace's invoices. Workspace
    // scoped like its settings: it goes with a solo workspace and stays with
    // a shared one, whose invoices keep their own frozen copy regardless.
    scoped("businessProfiles"),
    { collection: "authInvitations", filter: { organizationId: workspaceId } },
    { collection: "authOrganizations", filter: { id: workspaceId } },
    { collection: "authMembers", filter: { organizationId: workspaceId } },
    scoped("workspaceMembers"),
  ];
}

/**
 * Take one person out of a workspace other people still use.
 *
 * What goes is what was theirs: the entries they tracked, their pins, their
 * API tokens, the webhooks they created (deliveries are projected against the
 * creator's live visibility, so a webhook without its creator has no answer
 * to "what may this see") and the imports they ran.
 *
 * What stays is what belongs to the workspace:
 *  - the catalog (clients, projects, tasks, tags) — colleagues' entries point
 *    at it, and `createdBy` is a record, not ownership;
 *  - invoices, and the entries on them — an invoice is a document already sent
 *    to a customer, and its entries are the record behind it. Deleting them
 *    would leave a sent invoice pointing at nothing;
 *  - the workspace settings.
 *
 * `webhookIds` are this person's subscriptions in this workspace, read before
 * the subscriptions themselves are deleted — deliveries carry no `createdBy`.
 *
 * ACCOUNT DELETION ONLY. It deletes the person's entries, which is right when
 * the person is gone for good and wrong when they only leave a workspace or
 * are removed from one: that time was tracked for the workspace and stays
 * with it. Leave and remove go through `services/membership/lifecycle.ts`.
 */
export function memberDepartureSteps(
  workspaceId: string,
  userId: string,
  webhookIds: readonly string[],
): DeletionStep[] {
  return [
    ...(webhookIds.length > 0
      ? [
          {
            collection: "webhookDeliveries" as const,
            filter: { workspaceId, subscriptionId: { $in: [...webhookIds] } },
          },
        ]
      : []),
    { collection: "webhookSubscriptions", filter: { workspaceId, createdBy: userId } },
    { collection: "apiTokens", filter: { workspaceId, userId } },
    { collection: "favorites", filter: { workspaceId, userId } },
    {
      collection: "timeEntries",
      filter: { workspaceId, authorId: userId, invoiceId: null },
    },
    { collection: "importBatches", filter: { workspaceId, createdBy: userId } },
    {
      collection: "authInvitations",
      filter: { organizationId: workspaceId, inviterId: userId },
    },
    { collection: "authMembers", filter: { organizationId: workspaceId, userId } },
    { collection: "workspaceMembers", filter: { workspaceId, userId } },
  ];
}

/**
 * Rows keyed on the person rather than a workspace. Run after every workspace
 * has been dealt with, so it also sweeps anything a workspace step missed.
 *
 * Invitations addressed TO this email are removed too: a pending invite is
 * the only place the address would otherwise survive the account.
 */
export function userScopedSteps(user: { id: string; email?: string | null }): DeletionStep[] {
  const email = (user.email ?? "").trim().toLowerCase();
  return [
    { collection: "apiTokens", filter: { userId: user.id } },
    { collection: "favorites", filter: { userId: user.id } },
    { collection: "userPreferences", filter: { userId: user.id } },
    { collection: "profiles", filter: { userId: user.id } },
    { collection: "authDeviceCodes", filter: { userId: user.id } },
    ...(email ? [{ collection: "authInvitations" as const, filter: { email } }] : []),
  ];
}
