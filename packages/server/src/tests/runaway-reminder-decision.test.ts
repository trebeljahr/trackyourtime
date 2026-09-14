// The pure halves of the runaway reminder: who is owed an email, the filter
// that claims it, and what the email says. No database.
import assert from "node:assert/strict";
import test from "node:test";
import { buildRunawayReminderEmail } from "../services/email.js";
import {
  runawayReminderClaimFilter,
  runawayReminderDue,
  UNGUARDED_REMINDER_AFTER_SEC,
  type RunawayReminderEntry,
} from "../services/runaway.js";

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-09-14T09:00:00.000Z");

const entry = (overrides: Partial<RunawayReminderEntry> = {}): RunawayReminderEntry => ({
  start: new Date(NOW - 9 * HOUR),
  end: null,
  runaway: null,
  ...overrides,
});

const flagged = (resolvedAt: Date | null = null) => ({
  detectedAt: new Date(NOW - HOUR),
  elapsedSec: 8 * 3600,
  limitSec: 8 * 3600,
  action: "flagged" as const,
  resolvedAt,
});

test("a flagged, unanswered entry is owed a reminder at the guard's limit", () => {
  assert.deepEqual(
    runawayReminderDue(entry({ runaway: flagged() }), { maxHours: 8, behavior: "ask" }, NOW),
    { kind: "limit", limitSec: 8 * 3600 },
  );
});

test("with the guard on, an unflagged, answered or reminded entry is owed nothing", () => {
  const on = { maxHours: 8, behavior: "ask" } as const;
  assert.equal(runawayReminderDue(entry(), on, NOW).kind, "none");
  assert.equal(runawayReminderDue(entry({ runaway: flagged(new Date(NOW)) }), on, NOW).kind, "none");
  assert.equal(
    runawayReminderDue(entry({ runaway: flagged(), reminderSentAt: new Date(NOW) }), on, NOW).kind,
    "none",
  );
});

test("a stopped entry is never owed a reminder", () => {
  assert.equal(
    runawayReminderDue(
      entry({ end: new Date(NOW), runaway: flagged() }),
      { maxHours: 8, behavior: "ask" },
      NOW,
    ).kind,
    "none",
  );
});

test("with the guard off, the fixed threshold decides", () => {
  const off = { maxHours: 0, behavior: "ask" } as const;
  const justUnder = new Date(NOW - UNGUARDED_REMINDER_AFTER_SEC * 1000 + 1000);
  const exactly = new Date(NOW - UNGUARDED_REMINDER_AFTER_SEC * 1000);
  assert.equal(runawayReminderDue(entry({ start: justUnder }), off, NOW).kind, "none");
  assert.equal(runawayReminderDue(entry({ start: exactly }), off, NOW).kind, "unguarded");
  assert.equal(
    runawayReminderDue(entry({ start: exactly, reminderSentAt: new Date(NOW) }), off, NOW).kind,
    "none",
  );
});

test("the claim filter repeats the decision, and matches an absent reminderSentAt", () => {
  const now = new Date(NOW);
  assert.deepEqual(runawayReminderClaimFilter("e1", { kind: "limit", limitSec: 1 }, now), {
    _id: "e1",
    end: null,
    reminderSentAt: null,
    "runaway.action": "flagged",
    "runaway.resolvedAt": null,
  });
  assert.deepEqual(runawayReminderClaimFilter("e1", { kind: "unguarded" }, now), {
    _id: "e1",
    end: null,
    reminderSentAt: null,
    start: { $lte: new Date(NOW - UNGUARDED_REMINDER_AFTER_SEC * 1000) },
  });
});

test("the email names the entry, the duration, the limit and links to /track", () => {
  const email = buildRunawayReminderEmail({
    to: "alice@example.com",
    description: "Design <review>",
    start: new Date("2026-09-13T23:48:00.000Z"),
    now: new Date(NOW),
    limitSec: 8 * 3600,
    trackUrl: "https://app.example.com/track",
  });
  assert.equal(email.to, "alice@example.com");
  assert.equal(email.subject, "Your timer has been running for 9 h 12 min");
  assert.match(email.text, /"Design <review>" started at 2026-09-13 23:48 UTC/);
  assert.match(email.text, /past your 8 h limit/);
  assert.match(email.text, /https:\/\/app\.example\.com\/track/);
  assert.match(email.html, /Design &lt;review&gt;/);
  assert.doesNotMatch(email.html, /<review>/);
  assert.match(email.html, /href="https:\/\/app\.example\.com\/track"/);
});

test("the email reads sensibly with no description, no limit and no link", () => {
  const email = buildRunawayReminderEmail({
    to: "alice@example.com",
    description: "  ",
    start: new Date(NOW - 8 * HOUR),
    now: new Date(NOW),
    limitSec: null,
    trackUrl: null,
  });
  assert.equal(email.subject, "Your timer has been running for 8 h");
  assert.match(email.text, /"Untitled"/);
  assert.match(email.text, /If you forgot to stop it/);
  assert.doesNotMatch(email.text, /Open the tracker/);
  assert.doesNotMatch(email.html, /href=/);
});

test("the email is written in the recipient's language, with the name still escaped", () => {
  const email = buildRunawayReminderEmail({
    to: "alice@example.com",
    description: "Design <review>",
    start: new Date("2026-09-13T23:48:00.000Z"),
    now: new Date(NOW),
    limitSec: 8 * 3600,
    trackUrl: "https://app.example.com/track",
    locale: "de",
  });
  assert.equal(email.subject, "Dein Timer läuft seit 9 h 12 min");
  assert.match(email.text, /„Design <review>“ wurde um 2026-09-13 23:48 UTC gestartet/);
  assert.match(email.text, /maximale Eintragsdauer von 8\u00a0h/);
  assert.match(email.html, /<strong>Design &lt;review&gt;<\/strong>/);
  assert.match(email.html, />Timer öffnen</);
});
