import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  billedPeriodDates,
  cleanLine,
  cleanText,
  formatDecimal,
  formatPercent,
  lastBilledDateKey,
  localDateKey,
  safeFilenamePart,
  utcDateKey,
} from "../services/einvoice/format.js";

describe("formatPercent", () => {
  it("always writes two decimals", () => {
    assert.equal(formatPercent(19), "19.00");
    assert.equal(formatPercent(7), "7.00");
    assert.equal(formatPercent(7.5), "7.50");
    assert.equal(formatPercent(0), "0.00");
    assert.equal(formatPercent(100), "100.00");
  });

  it("writes -0 as 0.00", () => {
    assert.equal(formatPercent(-0), "0.00");
  });

  it("absorbs float artefacts that still mean a 2-decimal rate", () => {
    assert.equal(formatPercent(0.1 + 0.2), "0.30");
    assert.equal(formatPercent(19.99), "19.99");
  });

  it("refuses more than two decimals, negatives and non-finite rates", () => {
    assert.throws(() => formatPercent(7.555), RangeError);
    assert.throws(() => formatPercent(-1), RangeError);
    assert.throws(() => formatPercent(Number.NaN), RangeError);
    assert.throws(() => formatPercent(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => formatPercent(101), RangeError);
  });
});

describe("formatDecimal", () => {
  it("writes between 2 and 6 fraction digits", () => {
    assert.equal(formatDecimal(95), "95.00");
    assert.equal(formatDecimal(87.5), "87.50");
    assert.equal(formatDecimal(33.333333), "33.333333");
    assert.equal(formatDecimal(33.3333333), "33.333333");
    assert.equal(formatDecimal(0.125), "0.125");
    assert.equal(formatDecimal(0), "0.00");
    assert.equal(formatDecimal(-0), "0.00");
  });

  it("rounds ties away from zero on the decimal the number means", () => {
    assert.equal(formatDecimal(1.005, 2), "1.01");
    assert.equal(formatDecimal(2.0000005), "2.000001");
    assert.equal(formatDecimal(0.1 + 0.2), "0.30");
    assert.equal(formatDecimal(1e-7), "0.00");
    assert.equal(formatDecimal(5e-7), "0.000001");
  });

  it("never writes an exponent or a grouping separator", () => {
    const out = formatDecimal(123456789.5);
    assert.equal(out, "123456789.50");
    assert.doesNotMatch(out, /[e,]/i);
  });

  it("refuses negative, non-finite and out-of-range values", () => {
    assert.throws(() => formatDecimal(-0.01), RangeError);
    assert.throws(() => formatDecimal(1e21), RangeError);
    assert.throws(() => formatDecimal(Number.NaN), RangeError);
    assert.throws(() => formatDecimal(1, 1), RangeError);
  });
});

describe("dates", () => {
  it("reads issue and due dates as UTC calendar dates", () => {
    assert.equal(utcDateKey("2026-10-01T00:00:00.000Z"), "20261001");
    assert.equal(utcDateKey("2026-10-15T23:59:59.999Z"), "20261015");
  });

  it("reads the range bounds as local calendar dates and the end as exclusive", () => {
    const from = new Date(2026, 8, 1).toISOString();
    const to = new Date(2026, 9, 1).toISOString();
    assert.equal(localDateKey(from), "20260901");
    assert.equal(lastBilledDateKey(to), "20260930");
    assert.deepEqual(billedPeriodDates(from, to), { start: "2026-09-01", end: "2026-09-30" });
  });

  it("gives the right last day for an end bound after midnight", () => {
    assert.equal(lastBilledDateKey(new Date(2026, 8, 30, 18, 0).toISOString()), "20260930");
  });

  it("refuses an unreadable date", () => {
    assert.throws(() => utcDateKey("not a date"), RangeError);
  });

  for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
    it(`gives the same keys under TZ=${tz}`, () => {
      const here = fileURLToPath(new URL("../services/einvoice/format.ts", import.meta.url));
      const script = [
        `const f = await import(${JSON.stringify(here)});`,
        "const from = new Date(2026, 8, 1).toISOString();",
        "const to = new Date(2026, 9, 1).toISOString();",
        "const issue = new Date(Date.UTC(2026, 9, 1)).toISOString();",
        "console.log([f.localDateKey(from), f.lastBilledDateKey(to), f.utcDateKey(issue)].join(','));",
      ].join("\n");
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "20260901,20260930,20261001");
    });
  }
});

describe("text", () => {
  it("cleanText normalises line endings, trims each line and keeps inner newlines", () => {
    assert.equal(cleanText("  first  \r\nsecond\t\rthird \u0007 "), "first\nsecond\nthird");
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");
  });

  it("cleanLine collapses every whitespace run to one space", () => {
    assert.equal(cleanLine(" Acme\r\n  Consulting\tGmbH "), "Acme Consulting GmbH");
  });
});

describe("safeFilenamePart", () => {
  it("follows the invoice PDF filename rule", () => {
    assert.equal(safeFilenamePart("2026-014"), "2026-014");
    assert.equal(safeFilenamePart(" RE/2026 #7 "), "RE-2026-7");
    assert.equal(safeFilenamePart("///"), "document");
    assert.equal(safeFilenamePart("x".repeat(80)).length, 60);
  });
});
