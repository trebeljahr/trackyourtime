// The first issued XML is served forever; drafts are always generated fresh.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideIssuedXml } from "../services/einvoice/issued-xml.js";

const stored = { xml: "<rsm:CrossIndustryInvoice/>", generatedAt: new Date("2026-09-14T08:00:00.000Z"), generator: "track-your-time-cii/1" };

describe("decideIssuedXml", () => {
  it("serves the stored XML whatever the status", () => {
    for (const status of ["draft", "sent", "paid"] as const) {
      assert.deepEqual(decideIssuedXml(status, stored), { kind: "stored", xml: stored.xml });
    }
  });

  it("generates and persists for a sent or paid invoice without one", () => {
    assert.deepEqual(decideIssuedXml("sent", null), { kind: "generate", persist: true });
    assert.deepEqual(decideIssuedXml("paid", undefined), { kind: "generate", persist: true });
  });

  it("generates without persisting for a draft", () => {
    assert.deepEqual(decideIssuedXml("draft", null), { kind: "generate", persist: false });
  });

  it("does not serve an empty stored XML", () => {
    assert.deepEqual(decideIssuedXml("sent", { ...stored, xml: "" }), { kind: "generate", persist: true });
  });
});
