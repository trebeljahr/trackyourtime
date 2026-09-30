// The one thing between an unprojected envelope and somebody else's money.
//
// A webhook is a standing grant, so the projection is the ONLY place the
// permission question gets re-asked after the subscription was created. If it
// is wrong, nothing else in the pipeline notices: the delivery succeeds, the
// receiver stores the rate, and the leak is discovered when somebody reads
// their integration's database months later.
//
// Every case here is therefore stated from the negative side — what must NOT
// be on the wire — rather than from the happy path.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Subpath imports: a bare named import from "@starter/shared" throws under
// tsx. See the note in ws-sync.test.ts.
import type { Visibility, TimeEntry } from "@starter/shared/types";
import type { WebhookEnvelope } from "@starter/shared/webhooks";
import { projectWebhookEnvelope } from "../services/webhooks/projection.js";

const ME = "user-me";
const COLLEAGUE = "user-colleague";

const visibility = (
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): Visibility => ({ userId: ME, canViewOthersTime, canViewOthersMoney });

const entry = (authorId: string): TimeEntry => ({
  id: "entry-1",
  workspaceId: "ws-1",
  authorId,
  description: "Design review",
  projectId: null,
  taskId: null,
  tagIds: [],
  billable: true,
  hourlyRate: 12500,
  currency: "EUR",
  start: "2026-09-07T09:00:00.000Z",
  end: "2026-09-07T10:00:00.000Z",
  durationSec: 3600,
  source: "web",
  timeZone: "Europe/Berlin",
  runaway: null,
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
});

const envelopeFor = (
  event: WebhookEnvelope["event"],
  data: WebhookEnvelope["data"],
): WebhookEnvelope => ({
  id: "delivery-1",
  event,
  workspaceId: "ws-1",
  createdAt: "2026-09-07T10:00:00.000Z",
  data,
});

const entryEnvelope = (authorId: string): WebhookEnvelope =>
  envelopeFor("entry.stopped", { kind: "entry", entry: entry(authorId) });

/** Pull the entry back out of a projected envelope, or fail the assertion. */
const projectedEntry = (envelope: WebhookEnvelope): TimeEntry => {
  assert.equal(envelope.data.kind, "entry");
  if (envelope.data.kind !== "entry") throw new Error("unreachable");
  return envelope.data.entry;
};

describe("projectWebhookEnvelope — time visibility", () => {
  it("withholds a colleague's entry entirely, not merely its rate", () => {
    // Withheld, not stripped: without `canViewOthersTime` the EXISTENCE of
    // the entry is the thing being hidden. A delivery carrying a colleague's
    // description with a null rate would still say who worked when.
    const result = projectWebhookEnvelope(
      entryEnvelope(COLLEAGUE),
      visibility(false, false),
    );
    assert.equal(result, null);
  });

  it("withholds a colleague's entry even when money is visible", () => {
    // The two flags are independent. Money without time must not become a
    // back door onto the time it is attached to.
    const result = projectWebhookEnvelope(
      entryEnvelope(COLLEAGUE),
      visibility(false, true),
    );
    assert.equal(result, null);
  });

  it("always delivers the owner's own entry, with its own rate", () => {
    // Both flags false is the default position for a new member, and it must
    // not stop their OWN webhook from working.
    const result = projectWebhookEnvelope(
      entryEnvelope(ME),
      visibility(false, false),
    );
    assert.ok(result);
    assert.equal(projectedEntry(result).hourlyRate, 12500);
  });
});

describe("projectWebhookEnvelope — money visibility", () => {
  it("strips a colleague's rate when only time is visible", () => {
    const result = projectWebhookEnvelope(
      entryEnvelope(COLLEAGUE),
      visibility(true, false),
    );
    assert.ok(result);
    const projected = projectedEntry(result);
    assert.equal(projected.hourlyRate, null);
    // Currency is workspace configuration ("this workspace bills in EUR"),
    // not an amount, and the receiver needs it to format the entries it IS
    // allowed to see.
    assert.equal(projected.currency, "EUR");
    // Everything non-monetary survives — a strip, not a redaction.
    assert.equal(projected.description, "Design review");
    assert.equal(projected.durationSec, 3600);
  });

  it("keeps the rate when both flags are set", () => {
    const result = projectWebhookEnvelope(
      entryEnvelope(COLLEAGUE),
      visibility(true, true),
    );
    assert.ok(result);
    assert.equal(projectedEntry(result).hourlyRate, 12500);
  });

  it("never mutates the stored envelope", () => {
    // The row on disk stays unprojected so a LATER delivery to a
    // better-privileged subscription still has the rate. An in-place strip
    // here would silently downgrade every sibling delivery of the same event.
    const original = entryEnvelope(COLLEAGUE);
    projectWebhookEnvelope(original, visibility(true, false));
    assert.equal(projectedEntry(original).hourlyRate, 12500);
  });
});

describe("projectWebhookEnvelope — deletions", () => {
  const deleted = (authorId: string): WebhookEnvelope =>
    envelopeFor("entry.deleted", {
      kind: "entry-deleted",
      id: "entry-1",
      authorId,
    });

  it("withholds a colleague's deletion without time visibility", () => {
    assert.equal(
      projectWebhookEnvelope(deleted(COLLEAGUE), visibility(false, true)),
      null,
    );
  });

  it("delivers the owner's own deletion", () => {
    assert.ok(projectWebhookEnvelope(deleted(ME), visibility(false, false)));
  });

  it("delivers a colleague's deletion with time visibility", () => {
    assert.ok(
      projectWebhookEnvelope(deleted(COLLEAGUE), visibility(true, false)),
    );
  });
});

describe("projectWebhookEnvelope — invoices", () => {
  // An invoice is money end to end: a total, a set of line amounts and a rate
  // per line. There is no non-money residue worth delivering, so it is
  // withheld whole rather than sent with holes punched in it.
  const invoice = {
    id: "inv-1",
    workspaceId: "ws-1",
    number: "2026-001",
    status: "sent",
    total: 250_00,
  } as unknown as Extract<
    WebhookEnvelope["data"],
    { kind: "invoice" }
  >["invoice"];

  const envelopes = [
    envelopeFor("invoice.created", { kind: "invoice", invoice }),
    envelopeFor("invoice.status_changed", {
      kind: "invoice-status",
      invoice,
      from: "draft",
      to: "sent",
    }),
  ];

  for (const envelope of envelopes) {
    for (const role of ["owner", "admin", "member"] as const) {
      for (const time of [false, true]) {
        for (const money of [false, true]) {
          it(`${envelope.event}: ${role}, time=${time}, money=${money}`, () => {
            const result = projectWebhookEnvelope(
              envelope,
              visibility(time, money),
              role,
            );
            assert.equal(
              result,
              role !== "member" && time && money ? envelope : null,
            );
          });
        }
      }
    }

    it(`${envelope.event}: missing role fails closed`, () => {
      assert.equal(projectWebhookEnvelope(envelope, visibility(true, true)), null);
    });

    it(`${envelope.event}: reprojects queued payload after a downgrade`, () => {
      assert.equal(
        projectWebhookEnvelope(envelope, visibility(true, true), "admin"),
        envelope,
      );
      assert.equal(
        projectWebhookEnvelope(envelope, visibility(true, true), "member"),
        null,
      );
      assert.equal(
        projectWebhookEnvelope(envelope, visibility(false, true), "admin"),
        null,
      );
      assert.equal(
        projectWebhookEnvelope(envelope, visibility(true, false), "admin"),
        null,
      );
    });
  }
});
