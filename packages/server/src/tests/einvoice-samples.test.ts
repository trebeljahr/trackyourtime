import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { main } from "../scripts/einvoice-samples.js";
import { EINVOICE_CASES, fixturePath } from "./fixtures/einvoice/cases.js";

describe("einvoice-samples", () => {
  const out = mkdtempSync(join(tmpdir(), "einvoice-samples-"));
  after(() => rmSync(out, { recursive: true, force: true }));

  it("writes every golden XML and one ZUGFeRD PDF per case", async () => {
    const lines: string[] = [];
    const result = await main({ out, log: (line) => lines.push(line) });

    const xmlNames = EINVOICE_CASES.flatMap((c) => c.profiles.map((p) => `${c.name}.${p}.xml`));
    const pdfNames = EINVOICE_CASES.map((c) => `${c.name}.zugferd.pdf`);
    assert.deepEqual(readdirSync(out).sort(), [...xmlNames, ...pdfNames].sort());
    assert.deepEqual(result.files.map((file) => basename(file)).sort(), [...xmlNames, ...pdfNames].sort());

    for (const name of xmlNames) {
      assert.equal(readFileSync(join(out, name), "utf8"), readFileSync(fixturePath(name), "utf8"));
    }
    for (const name of pdfNames) {
      assert.equal(readFileSync(join(out, name)).subarray(0, 5).toString("latin1"), "%PDF-");
    }
    // One line per file, and nothing else.
    assert.equal(lines.length, result.files.length);
  });

  it("limits the run to one case with --only", async () => {
    const single = mkdtempSync(join(tmpdir(), "einvoice-samples-only-"));
    try {
      const result = await main({ out: single, only: "zero-rated", log: () => undefined });
      assert.ok(result.files.every((file) => basename(file).startsWith("zero-rated.")));
      assert.ok(result.files.length >= 2);
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });

  it("refuses an unknown case", async () => {
    await assert.rejects(main({ out, only: "no-such-case", log: () => undefined }), /unknown e-invoice case/);
  });
});
