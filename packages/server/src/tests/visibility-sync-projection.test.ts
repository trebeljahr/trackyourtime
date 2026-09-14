// What the sync socket may tell each member of a shared workspace.
//
// `publishSync` used to send one identical event to every member. That was
// correct only while a workspace had one member: the first colleague to join
// would have received every `timer.started` in the workspace — description,
// project and `hourlyRate` included — while the reports correctly hid the same
// rows from them. Nothing on the wire looks wrong when that happens, so this
// file states every cell of the recipient x kind matrix from the negative
// side, each paired with the recipient who may see it.
//
// Two layers: `projectSyncEventFor` is the pure rule, and `publishSync` is
// driven end to end with the membership read and the room broadcast stubbed,
// so the fan-out (who is sent what, and the envelope's `workspaceId`) is
// tested rather than assumed.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import type {
  ServerToClientMessage,
  SyncEvent,
  TimeEntry,
} from "@starter/shared";
import { canUseInvoices } from "@starter/shared";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { roomManager } from "../ws/handler.js";
import {
  projectSyncEventFor,
  publishSync,
  type SyncRecipient,
} from "../ws/sync.js";

mongoose.set("bufferCommands", false);

const WORKSPACE = "ws_shared";

/** The four visibilities a recipient can hold, named by what they may see. */
const AUTHOR: SyncRecipient = {
  userId: "user_author",
  role: "member",
  // Deliberately the narrowest flags: an author sees their own work because
  // they wrote it, never because a flag happens to be on.
  canViewOthersTime: false,
  canViewOthersMoney: false,
};
const TIME_ONLY: SyncRecipient = {
  userId: "user_time_only",
  role: "admin",
  canViewOthersTime: true,
  canViewOthersMoney: false,
};
const TIME_AND_MONEY: SyncRecipient = {
  userId: "user_time_money",
  role: "admin",
  canViewOthersTime: true,
  canViewOthersMoney: true,
};
const CLOSED: SyncRecipient = {
  userId: "user_closed",
  role: "member",
  canViewOthersTime: false,
  canViewOthersMoney: false,
};

const entryBy = (authorId: string): TimeEntry => ({
  id: "entry-1",
  workspaceId: WORKSPACE,
  authorId,
  description: "Confidential pitch for Globex",
  projectId: "project-secret",
  taskId: null,
  tagIds: [],
  billable: true,
  hourlyRate: 12500,
  currency: "EUR",
  start: "2026-09-07T09:00:00.000Z",
  end: null,
  durationSec: 0,
  source: "web",
  timeZone: "Europe/Berlin",
  runaway: null,
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T09:00:00.000Z",
});

const ENTRY_KINDS = ["entry.upserted", "timer.started", "timer.stopped"] as const;

const entryEvent = (
  kind: (typeof ENTRY_KINDS)[number],
  authorId: string,
): SyncEvent => ({ kind, entry: entryBy(authorId) });

const entryOf = (event: SyncEvent | null): TimeEntry => {
  assert.ok(event, "expected the event to be delivered");
  assert.ok("entry" in event, "expected an entry-bearing event");
  return event.entry;
};

// ── the pure rule ────────────────────────────────────────────────────

describe("projectSyncEventFor — entry-bearing kinds", () => {
  for (const kind of ENTRY_KINDS) {
    it(`${kind}: the author receives their own entry unchanged`, () => {
      const event = entryEvent(kind, AUTHOR.userId);
      assert.equal(projectSyncEventFor(event, AUTHOR), event);
    });

    it(`${kind}: a closed member receives NOTHING, not a redacted shell`, () => {
      const event = entryEvent(kind, AUTHOR.userId);
      assert.equal(projectSyncEventFor(event, CLOSED), null);
    });

    it(`${kind}: a time-only member receives it with hourlyRate withheld`, () => {
      const event = entryEvent(kind, AUTHOR.userId);
      const entry = entryOf(projectSyncEventFor(event, TIME_ONLY));
      assert.equal(entry.hourlyRate, null);
      // Time is what this recipient may see, so the rest stays.
      assert.equal(entry.description, "Confidential pitch for Globex");
      assert.equal(entry.projectId, "project-secret");
      // The original is not mutated for the recipients after this one.
      assert.equal(event.kind === kind && entryOf(event).hourlyRate, 12500);
    });

    it(`${kind}: a time+money member receives it in full`, () => {
      const event = entryEvent(kind, AUTHOR.userId);
      assert.equal(entryOf(projectSyncEventFor(event, TIME_AND_MONEY)).hourlyRate, 12500);
    });
  }
});

describe("projectSyncEventFor — entry.deleted (id only)", () => {
  const event: SyncEvent = { kind: "entry.deleted", id: "entry-1" };
  const audience = { authorId: AUTHOR.userId };

  it("reaches the author, even with both flags closed", () => {
    assert.equal(projectSyncEventFor(event, AUTHOR, audience), event);
  });

  it("does not tell a closed member that a colleague's entry vanished", () => {
    assert.equal(projectSyncEventFor(event, CLOSED, audience), null);
  });

  it("reaches members who may see the author's time", () => {
    assert.equal(projectSyncEventFor(event, TIME_ONLY, audience), event);
    assert.equal(projectSyncEventFor(event, TIME_AND_MONEY, audience), event);
  });

  it("without an audience fails CLOSED: only members who see everybody's time", () => {
    assert.equal(projectSyncEventFor(event, AUTHOR), null);
    assert.equal(projectSyncEventFor(event, CLOSED), null);
    assert.equal(projectSyncEventFor(event, TIME_ONLY), event);
    assert.equal(projectSyncEventFor(event, TIME_AND_MONEY), event);
  });
});

describe("projectSyncEventFor — data.imported", () => {
  const event: SyncEvent = { kind: "data.imported", batchId: "b1", undone: false };
  const audience = { authorId: AUTHOR.userId };

  it("follows the entry audience: author and time-visible members only", () => {
    assert.equal(projectSyncEventFor(event, AUTHOR, audience), event);
    assert.equal(projectSyncEventFor(event, CLOSED, audience), null);
    assert.equal(projectSyncEventFor(event, TIME_ONLY, audience), event);
    assert.equal(projectSyncEventFor(event, TIME_AND_MONEY, audience), event);
  });
});

describe("projectSyncEventFor — invoice.changed", () => {
  const event: SyncEvent = { kind: "invoice.changed", id: "invoice-1" };

  it("reaches only recipients canUseInvoices allows", () => {
    const owner: SyncRecipient = { ...TIME_AND_MONEY, role: "owner" };
    const plainMemberBothFlags: SyncRecipient = {
      ...TIME_AND_MONEY,
      role: "member",
    };
    for (const recipient of [
      AUTHOR,
      CLOSED,
      TIME_ONLY,
      TIME_AND_MONEY,
      owner,
      plainMemberBothFlags,
    ]) {
      const allowed = canUseInvoices(recipient.role, {
        userId: recipient.userId,
        canViewOthersTime: recipient.canViewOthersTime,
        canViewOthersMoney: recipient.canViewOthersMoney,
      });
      assert.equal(
        projectSyncEventFor(event, recipient),
        allowed ? event : null,
        `${recipient.userId} as ${recipient.role}`,
      );
    }
    // The matrix above must not be vacuous in either direction.
    assert.equal(projectSyncEventFor(event, owner), event);
    assert.equal(projectSyncEventFor(event, TIME_ONLY), null);
    assert.equal(projectSyncEventFor(event, plainMemberBothFlags), null);
  });
});

describe("projectSyncEventFor — shared configuration passes through", () => {
  const passthrough: SyncEvent[] = [
    { kind: "catalog.changed", scope: "project" },
    { kind: "favorites.changed" },
    { kind: "settings.changed" },
    { kind: "integrations.changed", scope: "webhook" },
  ];
  for (const event of passthrough) {
    it(`${event.kind} reaches every member`, () => {
      for (const recipient of [AUTHOR, CLOSED, TIME_ONLY, TIME_AND_MONEY]) {
        assert.equal(projectSyncEventFor(event, recipient), event);
      }
    });
  }
});

// ── the fan-out ──────────────────────────────────────────────────────

type SentMessage = { roomId: string; message: ServerToClientMessage };

type LeanChain<T> = { select: () => { lean: () => Promise<T> } };

const stubbableMember = WorkspaceMember as unknown as {
  find: (filter: Record<string, unknown>) => LeanChain<SyncRecipient[]>;
};
const realFind = stubbableMember.find;
const realBroadcast = roomManager.broadcast.bind(roomManager);

/** The acceptance fixture: owner O, admin A (time, no money), member M. */
const O: SyncRecipient = {
  userId: "user_o",
  role: "owner",
  canViewOthersTime: true,
  canViewOthersMoney: true,
};
const A: SyncRecipient = {
  userId: "user_a",
  role: "admin",
  canViewOthersTime: true,
  canViewOthersMoney: false,
};
const M: SyncRecipient = {
  userId: "user_m",
  role: "member",
  canViewOthersTime: false,
  canViewOthersMoney: false,
};

let members: SyncRecipient[] = [O, A, M];
let sent: SentMessage[] = [];
let failMembershipRead = false;

stubbableMember.find = (filter) => ({
  select: () => ({
    lean: async () => {
      if (failMembershipRead) throw new Error("database unavailable");
      return filter.workspaceId === WORKSPACE ? members : [];
    },
  }),
});
roomManager.broadcast = (roomId: string, message: ServerToClientMessage) => {
  sent.push({ roomId, message });
};

after(() => {
  stubbableMember.find = realFind;
  roomManager.broadcast = realBroadcast;
});

beforeEach(() => {
  members = [O, A, M];
  sent = [];
  failMembershipRead = false;
});

const deliveredTo = (userId: string): Extract<ServerToClientMessage, { type: "tt:sync" }>[] =>
  sent
    .filter((item) => item.roomId === `user:${userId}`)
    .map((item) => item.message)
    .filter(
      (message): message is Extract<ServerToClientMessage, { type: "tt:sync" }> =>
        message.type === "tt:sync",
    );

const onlyEventTo = (userId: string): SyncEvent => {
  const messages = deliveredTo(userId);
  assert.equal(messages.length, 1, `expected one event for ${userId}`);
  const [message] = messages;
  assert.ok(message);
  return message.event;
};

describe("publishSync — per-recipient fan-out", () => {
  it("O's timer.started reaches O in full, A without the rate, and never M", async () => {
    await publishSync(WORKSPACE, entryEvent("timer.started", O.userId), "tab-1");

    assert.equal(entryOf(onlyEventTo(O.userId)).hourlyRate, 12500);
    const forA = entryOf(onlyEventTo(A.userId));
    assert.equal(forA.hourlyRate, null);
    assert.equal(forA.description, "Confidential pitch for Globex");
    assert.equal(deliveredTo(M.userId).length, 0);
    // Nothing about the event reaches M's room at all — not even its origin.
    assert.equal(
      sent.filter((item) => item.roomId === `user:${M.userId}`).length,
      0,
    );
  });

  it("M's own events reach M in full and O in full; A without M's rate", async () => {
    await publishSync(WORKSPACE, entryEvent("entry.upserted", M.userId));

    assert.equal(entryOf(onlyEventTo(M.userId)).hourlyRate, 12500);
    assert.equal(entryOf(onlyEventTo(O.userId)).hourlyRate, 12500);
    assert.equal(entryOf(onlyEventTo(A.userId)).hourlyRate, null);
  });

  it("entry.deleted for O's entry reaches O and A only", async () => {
    await publishSync(
      WORKSPACE,
      { kind: "entry.deleted", id: "entry-1" },
      undefined,
      { authorId: O.userId },
    );
    assert.equal(deliveredTo(O.userId).length, 1);
    assert.equal(deliveredTo(A.userId).length, 1);
    assert.equal(deliveredTo(M.userId).length, 0);
  });

  it("entry.deleted for M's entry still reaches M's own devices", async () => {
    await publishSync(
      WORKSPACE,
      { kind: "entry.deleted", id: "entry-1" },
      undefined,
      { authorId: M.userId },
    );
    assert.equal(deliveredTo(M.userId).length, 1);
    assert.equal(deliveredTo(O.userId).length, 1);
    assert.equal(deliveredTo(A.userId).length, 1);
  });

  it("invoice.changed reaches only O", async () => {
    await publishSync(WORKSPACE, { kind: "invoice.changed", id: "invoice-1" });
    assert.equal(deliveredTo(O.userId).length, 1);
    assert.equal(deliveredTo(A.userId).length, 0);
    assert.equal(deliveredTo(M.userId).length, 0);
  });

  it("catalog.changed reaches everybody", async () => {
    await publishSync(WORKSPACE, { kind: "catalog.changed", scope: "tag" });
    for (const member of [O, A, M]) {
      assert.equal(deliveredTo(member.userId).length, 1, member.userId);
    }
  });

  it("stamps every envelope with the workspace and echoes the origin", async () => {
    await publishSync(WORKSPACE, { kind: "settings.changed" }, "tab-9");
    assert.equal(sent.length, 3);
    for (const { message } of sent) {
      assert.equal(message.type, "tt:sync");
      if (message.type !== "tt:sync") continue;
      assert.equal(message.workspaceId, WORKSPACE);
      assert.equal(message.originId, "tab-9");
    }
  });

  it("a solo personal workspace still delivers the untouched event to its owner", async () => {
    members = [{ ...O }];
    const event = entryEvent("timer.stopped", O.userId);
    await publishSync(WORKSPACE, event);
    assert.equal(onlyEventTo(O.userId), event);
  });

  it("is best-effort: a failed membership read neither throws nor delivers", async () => {
    failMembershipRead = true;
    await publishSync(WORKSPACE, entryEvent("timer.started", O.userId));
    assert.equal(sent.length, 0);
  });
});
