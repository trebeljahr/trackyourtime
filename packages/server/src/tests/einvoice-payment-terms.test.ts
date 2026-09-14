// BT-20 is the sentence the plain PDF prints, in the invoice's language and
// with the date written the way the PDF writes every date.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paymentTermsDate, paymentTermsSentence } from "../services/einvoice/payment-terms.js";

describe("paymentTermsSentence", () => {
  it("states the terms and the due date in English by default", () => {
    assert.equal(paymentTermsSentence(undefined, 14, "2026-09-28T00:00:00.000Z"), "Payable within 14 days, by 2026-09-28.");
    assert.equal(paymentTermsSentence("en", 1, "2026-09-28"), "Payable within 1 day, by 2026-09-28.");
    assert.equal(paymentTermsSentence("en", 0, "2026-09-28"), "Payable on receipt, by 2026-09-28.");
    assert.equal(paymentTermsSentence(null, null, "2026-09-28"), "Payable by 2026-09-28.");
  });

  it("writes German, with the date as the German PDF prints it", () => {
    assert.equal(paymentTermsSentence("de", 14, "2026-09-28"), "Zahlbar innerhalb von 14 Tagen, bis zum 28.09.2026.");
    assert.equal(paymentTermsSentence("de", null, "2026-09-28T00:00:00.000Z"), "Zahlbar bis zum 28.09.2026.");
  });

  it("names the terms only when the due date is the issue date plus those days", () => {
    const issueDateIso = "2026-09-14T00:00:00.000Z";
    assert.equal(
      paymentTermsSentence("en", 14, "2026-09-28T00:00:00.000Z", { issueDateIso }),
      "Payable within 14 days, by 2026-09-28.",
    );
    // Moved off the suggestion: a term that contradicts its own date is not frozen.
    assert.equal(
      paymentTermsSentence("en", 14, "2026-10-05T00:00:00.000Z", { issueDateIso }),
      "Payable by 2026-10-05.",
    );
    assert.equal(
      paymentTermsSentence("de", 0, "2026-09-14T00:00:00.000Z", { issueDateIso }),
      "Zahlbar sofort nach Erhalt, bis zum 14.09.2026.",
    );
  });

  it("reads the calendar date of the stored UTC value, never a request offset", () => {
    // "2026-09-28T23:30:00-02:00" is stored as 2026-09-29T01:30Z.
    const stored = new Date("2026-09-28T23:30:00-02:00").toISOString();
    assert.equal(paymentTermsDate("en", stored), "2026-09-29");
    assert.equal(paymentTermsDate("de", stored), "29.09.2026");
  });

  it("never starts a line with # (BR-DE-18)", () => {
    for (const locale of ["en", "de"] as const) {
      for (const days of [null, 0, 1, 30]) {
        const sentence = paymentTermsSentence(locale, days, "2026-09-28");
        assert.equal(/^\s*#/m.test(sentence), false, sentence);
      }
    }
  });
});
