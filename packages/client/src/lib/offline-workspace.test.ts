/**
 * Queued rows and workspaces.
 *
 * A person in several workspaces can switch while a row waits, be removed from
 * a workspace while offline, or upgrade from a build that stamped nothing.
 * Each of those used to decide silently where tracked time landed. These pin
 * the client half: rows are stamped with the workspace they were made in,
 * replay into that workspace whatever is active now, and a row for a
 * workspace the account left is held and named — never replayed, never
 * deleted until someone says so. The pure queue rules are in core.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  replayOfflineMutation,
  type OfflineReplayMutators,
  type WorkspaceSummary,
} from "@starter/core";
import { createAppQueryClient } from "@/lib/query-client";

import {
  __resetActiveWorkspaceForTests,
  applyWorkspaceList,
  getActiveWorkspaceId,
  switchWorkspace,
} from "./active-workspace";
import {
  __resetOfflineQueueForTests,
  __resetOfflineQueueOwnerForTests,
  adoptUnstampedOfflineRows,
  discardForeignQueued,
  enqueueOffline,
  flushOfflineQueue,
  getForeignCount,
  getOfflineQueue,
  getPendingCount,
  listForeignQueued,
  refreshPendingCount,
  setOfflineQueueOwner,
  type OfflineStartInput,
} from "./offline";

const USER = "user-1";

const workspace = (
  id: string,
  name: string,
  isDefault = false,
): WorkspaceSummary => ({
  id,
  name,
  role: "member",
  memberCount: 3,
  isDefault,
  permissions: {
    inviteMembers: false,
    inviteAdmins: false,
    changeRoles: false,
    editTimeVisibility: false,
    editMoneyVisibility: false,
    removeMembers: false,
    transferOwnership: false,
    invoices: false,
    viewOthersTime: false,
    viewOthersMoney: false,
  },
});

const A = workspace("ws-a", "Acme", true);
const B = workspace("ws-b", "Beta");

const startInput = (description: string): OfflineStartInput => ({
  description,
  projectId: null,
  taskId: null,
  billable: false,
  start: "2026-09-14T09:00:00.000Z",
  source: "web",
  timeZone: "UTC",
  originId: "tab-1",
});

/** Replay through core's real runner, recording what each call was handed. */
const replayAll = async (
  memberWorkspaceIds?: ReadonlySet<string>,
): Promise<Array<{ description?: string; workspaceId?: string }>> => {
  const sent: Array<{ description?: string; workspaceId?: string }> = [];
  const record = async (input: object): Promise<unknown> => {
    sent.push(input as { description?: string; workspaceId?: string });
    return { id: `real-${sent.length}` };
  };
  const mutators: OfflineReplayMutators = {
    "entries.start": record,
    "entries.stop": record,
    "entries.create": record,
    "entries.update": record,
    "entries.remove": record,
    "entries.discard": record,
  };
  await flushOfflineQueue(
    async (mutation, meta) => {
      await replayOfflineMutation(
        mutators,
        { noteServerId: () => undefined },
        mutation,
        { createdAt: meta.createdAt, resolved: new Map() },
      );
    },
    memberWorkspaceIds === undefined ? {} : { memberWorkspaceIds },
  );
  return sent;
};

describe("offline rows and workspaces", () => {
  beforeEach(async () => {
    __resetOfflineQueueForTests();
    __resetOfflineQueueOwnerForTests();
    __resetActiveWorkspaceForTests();
    await setOfflineQueueOwner(USER);
  });

  it("stamps a queued row with the active workspace", async () => {
    await applyWorkspaceList([A, B], USER);
    await enqueueOffline("entries.start", startInput("x"), "temp-1");
    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.workspaceId)).toEqual([A.id]);
  });

  it("stamps the workspace the user acted in when the caller captured it", async () => {
    await applyWorkspaceList([A, B], USER);
    // The mutation began in B; the error arrived after a switch back to A.
    await enqueueOffline("entries.start", startInput("x"), "temp-1", B.id);
    const rows = await getOfflineQueue().list();
    expect(rows.map((row) => row.workspaceId)).toEqual([B.id]);
  });

  it("replays a row queued in A into A after a switch to B", async () => {
    await applyWorkspaceList([A, B], USER);
    await enqueueOffline("entries.start", startInput("in A"), "temp-1");

    await switchWorkspace(B.id, { queryClient: createAppQueryClient() });
    expect(getActiveWorkspaceId()).toBe(B.id);

    const sent = await replayAll(new Set([A.id, B.id]));
    expect(sent).toEqual([expect.objectContaining({ description: "in A", workspaceId: A.id })]);
    expect(await getOfflineQueue().size()).toBe(0);
  });

  it("holds rows for a workspace the account was removed from, counted and named", async () => {
    await applyWorkspaceList([A, B], USER);
    await enqueueOffline("entries.start", startInput("Retainer"), "temp-1", A.id);
    await enqueueOffline("entries.start", startInput("Beta work"), "temp-2", B.id);

    // Removed from A while the rows waited.
    const outcome = await applyWorkspaceList([B], USER);
    expect(outcome.activeId).toBe(B.id);
    expect(outcome.lost?.name).toBe("Acme");

    await refreshPendingCount();
    expect(getPendingCount()).toBe(1);
    expect(getForeignCount()).toBe(1);

    const sent = await replayAll(new Set([B.id]));
    // Not replayed into A (which would refuse and drop it) and not into B.
    expect(sent.map((input) => input.description)).toEqual(["Beta work"]);

    const held = await getOfflineQueue().list();
    expect(held.map((row) => row.workspaceId)).toEqual([A.id]);

    const listed = await listForeignQueued();
    expect(listed).toEqual([
      expect.objectContaining({
        description: "Retainer",
        leftWorkspace: true,
        workspaceId: A.id,
        // Remembered from before the removal, so the row can be named.
        workspaceName: "Acme",
        otherServer: null,
      }),
    ]);

    // Still there after another flush — deleted only by a deliberate discard.
    await replayAll(new Set([B.id]));
    expect(await getOfflineQueue().size()).toBe(1);
    expect(await discardForeignQueued()).toBe(1);
    expect(await getOfflineQueue().size()).toBe(0);
  });

  it("replays nothing stamped when no membership list is known", async () => {
    await applyWorkspaceList([A], USER);
    await enqueueOffline("entries.start", startInput("stamped"), "temp-1");
    __resetActiveWorkspaceForTests();

    const sent = await replayAll();
    expect(sent).toEqual([]);
    expect(await getOfflineQueue().size()).toBe(1);
  });

  it("adopts legacy unstamped rows into the active workspace, and they replay there", async () => {
    // A row from a build before workspace stamping.
    await getOfflineQueue().enqueue(
      "entries.start",
      { input: startInput("legacy"), tempId: "temp-9" },
      USER,
      "",
    );
    await applyWorkspaceList([A, B], USER);
    expect(await adoptUnstampedOfflineRows(A.id)).toBe(1);
    // A later switch does not carry the adopted row along.
    await switchWorkspace(B.id, { queryClient: createAppQueryClient() });
    expect(await adoptUnstampedOfflineRows(B.id)).toBe(0);

    const sent = await replayAll(new Set([A.id, B.id]));
    expect(sent).toEqual([expect.objectContaining({ description: "legacy", workspaceId: A.id })]);
  });
});
