// The runaway-reminder job against a real MongoDB: enforcement with no client
// connected, the one email per entry, and the lazy path finding nothing left
// to do after the job.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import type { MaxDurationSettings } from "@starter/shared/types";
import { UserPreferencesModel } from "../models/Settings.js";
import { Profile } from "../models/Profile.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";
import { WebhookSubscription } from "../models/WebhookSubscription.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { currentEntry, personReach } from "../services/entries/timer.js";
import { enforceMaxEntryDuration } from "../services/runaway.js";
import {
  runRunawayReminders,
  type RunawayReminderDeps,
} from "../services/scheduler/runaway-reminder.js";
import { roomManager } from "../ws/handler.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const HOUR = 3600 * 1000;
const ALICE = "64b7f9c2e13a4d5f6a7b8c01";
const WORKSPACE = "ws_acme";
const NOW = new Date("2026-09-14T09:00:00.000Z");
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR);
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

type Sent = { to: string; subject: string; text: string };

/** Everything that leaves the process, recorded. */
function fakes(overrides: Partial<RunawayReminderDeps> = {}): {
  deps: Partial<RunawayReminderDeps>;
  sent: Sent[];
  logs: string[];
} {
  const sent: Sent[] = [];
  const logs: string[] = [];
  return {
    sent,
    logs,
    deps: {
      sendEmail: async (params) => {
        sent.push({ to: params.to, subject: params.subject, text: params.text });
      },
      isEmailDeliveryConfigured: () => true,
      findUserEmail: async (userId) => (userId === ALICE ? "alice@example.com" : null),
      trackUrl: "https://app.example.com/track",
      log: (message) => logs.push(message),
      ...overrides,
    },
  };
}

/** Sync messages broadcast into rooms during a case. */
let broadcasts: { roomId: string; kind: string; entryId: string }[] = [];
const realBroadcast = roomManager.broadcast.bind(roomManager);

async function givenSettings(maxDuration: MaxDurationSettings): Promise<void> {
  await UserPreferencesModel.create({ userId: ALICE, maxDuration });
}

async function givenRunning(startedHoursAgo: number): Promise<string> {
  const entry = await TimeEntry.create({
    workspaceId: WORKSPACE,
    authorId: ALICE,
    description: "Design review",
    start: hoursAgo(startedHoursAgo),
    end: null,
    source: "web",
  });
  return String(entry._id);
}

const read = async (id: string) => TimeEntry.findById(id).lean();

/**
 * Let fire-and-forget publishes land. `publishSync` resolves the workspace's
 * members before it broadcasts, and the guard does not await it.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

describe("runaway-reminder job", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("runaway-reminder", [
      TimeEntry as unknown as mongoose.Model<never>,
    ]);
    const stub = roomManager as unknown as {
      broadcast: (roomId: string, message: unknown) => void;
    };
    stub.broadcast = (roomId, message) => {
      const msg = message as { type: string; event?: { kind: string; entry?: { id: string } } };
      if (msg.type === "tt:sync" && msg.event) {
        broadcasts.push({ roomId, kind: msg.event.kind, entryId: msg.event.entry?.id ?? "" });
      }
    };
  });
  after(async () => {
    (roomManager as unknown as { broadcast: typeof realBroadcast }).broadcast = realBroadcast;
    await dropTestDatabase();
  });
  beforeEach(async () => {
    await clearTestDatabase();
    broadcasts = [];
    await WorkspaceMember.create({ workspaceId: WORKSPACE, userId: ALICE, role: "owner", name: "Alice" });
  });
  afterEach(() => {
    broadcasts = [];
  });

  it("cap: ends the entry at start + limit with no client asking, and syncs the stop", async () => {
    await givenSettings({ maxHours: 8, behavior: "cap" });
    const id = await givenRunning(10);
    const { deps, sent } = fakes();

    const summary = await runRunawayReminders(NOW, deps);

    await settle();
    const entry = await read(id);
    assert.equal(entry?.end?.toISOString(), hoursAgo(2).toISOString());
    assert.equal(entry?.runaway?.action, "capped");
    assert.equal(summary.ended, 1);
    assert.deepEqual(broadcasts, [
      { roomId: `user:${ALICE}`, kind: "timer.stopped", entryId: id },
    ]);
    assert.equal(sent.length, 0, "an ended timer needs no reminder");
  });

  it("stop: ends the entry where it had got to", async () => {
    await givenSettings({ maxHours: 8, behavior: "stop" });
    const id = await givenRunning(10);

    await runRunawayReminders(NOW, fakes().deps);

    await settle();
    const entry = await read(id);
    assert.equal(entry?.end?.toISOString(), NOW.toISOString());
    assert.equal(entry?.runaway?.action, "stopped");
    assert.equal(broadcasts.length, 1);
  });

  it("cap: enqueues entry.stopped for the workspace's webhooks", async () => {
    await givenSettings({ maxHours: 8, behavior: "cap" });
    const id = await givenRunning(10);
    await WebhookSubscription.create({
      workspaceId: WORKSPACE,
      createdBy: ALICE,
      url: "https://hooks.example.com/trackyourtime",
      secret: "whsec_test",
      events: ["entry.stopped"],
    });

    await runRunawayReminders(NOW, fakes().deps);
    await settle();

    const deliveries = await WebhookDelivery.find({ workspaceId: WORKSPACE }).lean();
    assert.deepEqual(
      deliveries.map((d) => [
        d.event,
        d.envelope.data.kind === "entry" ? d.envelope.data.entry.id : null,
      ]),
      [["entry.stopped", id]],
    );
  });

  it("does nothing to a timer under its limit", async () => {
    await givenSettings({ maxHours: 8, behavior: "cap" });
    const id = await givenRunning(7);
    const { deps, sent } = fakes();

    await runRunawayReminders(NOW, deps);
    await settle();

    assert.equal((await read(id))?.end, null);
    assert.equal(broadcasts.length, 0);
    assert.equal(sent.length, 0);
  });

  it("ask: flags the entry and sends exactly one reminder for it", async () => {
    await givenSettings({ maxHours: 8, behavior: "ask" });
    const id = await givenRunning(9);
    const { deps, sent } = fakes();

    await runRunawayReminders(NOW, deps);
    await runRunawayReminders(minutes(5), deps);
    await runRunawayReminders(minutes(10), deps);
    await settle();

    const entry = await read(id);
    assert.equal(entry?.end, null, "ask never ends the timer");
    assert.equal(entry?.runaway?.action, "flagged");
    assert.equal(entry?.reminderSentAt?.toISOString(), NOW.toISOString());
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, "alice@example.com");
    assert.match(sent[0]?.text ?? "", /Design review/);
    assert.match(sent[0]?.text ?? "", /past your 8 h limit/);
    assert.match(sent[0]?.text ?? "", /https:\/\/app\.example\.com\/track/);
    assert.deepEqual(
      broadcasts.map((b) => b.kind),
      ["entry.upserted"],
      "the flag is published once",
    );
  });

  it("ask: two runs racing send one email", async () => {
    await givenSettings({ maxHours: 8, behavior: "ask" });
    await givenRunning(9);
    const { deps, sent } = fakes();

    await Promise.all([
      runRunawayReminders(NOW, deps),
      runRunawayReminders(NOW, deps),
      runRunawayReminders(NOW, deps),
    ]);

    assert.equal(sent.length, 1);
  });

  it("ask: a flag already answered with keep earns no reminder", async () => {
    await givenSettings({ maxHours: 8, behavior: "ask" });
    const id = await givenRunning(9);
    await TimeEntry.updateOne(
      { _id: id },
      {
        $set: {
          runaway: {
            detectedAt: hoursAgo(1),
            elapsedSec: 8 * 3600,
            limitSec: 8 * 3600,
            action: "flagged",
            resolvedAt: hoursAgo(0.5),
          },
        },
      },
    );
    const { deps, sent } = fakes();

    await runRunawayReminders(NOW, deps);

    assert.equal(sent.length, 0);
  });

  it("guard off: one reminder once a timer passes 8 hours", async () => {
    await givenSettings({ maxHours: 0, behavior: "ask" });
    const id = await givenRunning(7.95);
    const { deps, sent } = fakes();

    await runRunawayReminders(NOW, deps);
    assert.equal(sent.length, 0, "not yet 8 hours");

    await runRunawayReminders(minutes(5), deps);
    await runRunawayReminders(minutes(10), deps);

    const entry = await read(id);
    assert.equal(entry?.end, null);
    assert.equal(entry?.runaway, null, "the guard is off, so nothing is flagged");
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /If you forgot to stop it/);
  });

  it("notifications off: no email, but cap still applies", async () => {
    await Profile.create({ userId: ALICE, preferences: { notifications: false } });
    await givenSettings({ maxHours: 8, behavior: "cap" });
    const capped = await givenRunning(10);
    const { deps, sent } = fakes();

    await runRunawayReminders(NOW, deps);

    assert.equal((await read(capped))?.runaway?.action, "capped");
    assert.equal(sent.length, 0);
  });

  it("notifications off: ask flags but does not email", async () => {
    await Profile.create({ userId: ALICE, preferences: { notifications: false } });
    await givenSettings({ maxHours: 8, behavior: "ask" });
    const id = await givenRunning(9);
    const { deps, sent } = fakes();

    const summary = await runRunawayReminders(NOW, deps);

    const entry = await read(id);
    assert.equal(entry?.runaway?.action, "flagged");
    assert.equal(entry?.reminderSentAt ?? null, null);
    assert.equal(sent.length, 0);
    assert.equal(summary.suppressed, 1);
  });

  it("no transport: logs once instead of sending", async () => {
    await givenSettings({ maxHours: 8, behavior: "ask" });
    const id = await givenRunning(9);
    const { deps, sent, logs } = fakes({ isEmailDeliveryConfigured: () => false });

    await runRunawayReminders(NOW, deps);
    await runRunawayReminders(minutes(5), deps);

    assert.equal(sent.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", new RegExp(id));
    assert.doesNotMatch(logs[0] ?? "", /alice@example\.com/);
  });

  it("a failed send is retried on the next run, not lost", async () => {
    await givenSettings({ maxHours: 8, behavior: "ask" });
    const id = await givenRunning(9);
    let fail = true;
    const { deps, sent } = fakes();
    const flaky: RunawayReminderDeps["sendEmail"] = async (params) => {
      if (fail) throw new Error("SMTP down");
      await deps.sendEmail?.(params);
    };

    await assert.rejects(
      runRunawayReminders(NOW, { ...deps, sendEmail: flaky }),
      /SMTP down/,
    );
    assert.equal((await read(id))?.reminderSentAt ?? null, null);

    fail = false;
    await runRunawayReminders(minutes(5), { ...deps, sendEmail: flaky });
    assert.equal(sent.length, 1);
  });

  it("the lazy path after the job finds nothing to stop again", async () => {
    await givenSettings({ maxHours: 8, behavior: "cap" });
    const id = await givenRunning(10);

    await runRunawayReminders(NOW, fakes().deps);
    const scope = {
      workspaceId: WORKSPACE,
      userId: ALICE,
      visibility: { userId: ALICE, canViewOthersTime: true, canViewOthersMoney: true },
    };
    assert.equal(await currentEntry(scope, personReach), null);
    assert.deepEqual(await enforceMaxEntryDuration(ALICE, null, minutes(1)), { kind: "none" });

    await settle();
    const entry = await read(id);
    assert.equal(entry?.end?.toISOString(), hoursAgo(2).toISOString());
    assert.deepEqual(
      broadcasts.map((b) => b.kind),
      ["timer.stopped"],
      "exactly one stop published",
    );
  });

  it("the job after the lazy path finds nothing to stop again", async () => {
    await givenSettings({ maxHours: 8, behavior: "cap" });
    await givenRunning(10);

    assert.equal((await enforceMaxEntryDuration(ALICE, null, NOW)).kind, "ended");
    const summary = await runRunawayReminders(minutes(1), fakes().deps);

    await settle();
    assert.equal(summary.people, 0);
    assert.equal(broadcasts.length, 1);
  });
});
