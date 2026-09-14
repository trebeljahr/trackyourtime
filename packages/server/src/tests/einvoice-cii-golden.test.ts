import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";
import { EINVOICE_CASES, fixturePath } from "./fixtures/einvoice/cases.js";

// The committed golden files are the contract for the serializer's output, and
// the exact files `pnpm einvoice:validate` runs through the Java validators.
// UPDATE_GOLDEN=1 regenerates them: a decision to review, never a fix.
const update = process.env.UPDATE_GOLDEN === "1";

const goldenName = (caseName: string, profile: string): string => `${caseName}.${profile}.xml`;

describe("CII golden files", () => {
  for (const c of EINVOICE_CASES) {
    for (const profile of c.profiles) {
      it(`${c.name} (${profile}) matches its golden file`, () => {
        // The matrix itself must pass validate.ts, or the golden documents an unreachable output.
        const ready = assertEinvoiceReady(c.invoice(), profile);
        const xml = buildCiiXml(ready, profile);
        const file = fixturePath(goldenName(c.name, profile));
        if (update) {
          writeFileSync(file, xml);
          return;
        }
        assert.ok(
          existsSync(file),
          `missing golden ${goldenName(c.name, profile)}: run UPDATE_GOLDEN=1 pnpm --filter @starter/server test`,
        );
        assert.equal(
          xml,
          readFileSync(file, "utf8"),
          "output changed: regenerate with UPDATE_GOLDEN=1, review the diff, and run pnpm einvoice:validate",
        );
      });
    }
  }

  it("has no orphaned golden files", () => {
    const expected = new Set(EINVOICE_CASES.flatMap((c) => c.profiles.map((p) => goldenName(c.name, p))));
    const folder = dirname(fixturePath("cases.ts"));
    const orphans = readdirSync(folder).filter((file) => file.endsWith(".xml") && !expected.has(file));
    assert.deepEqual(orphans, [], "delete golden files that no longer belong to a (case, profile) pair");
  });

  it("is never regenerated in CI", () => {
    if (process.env.CI) assert.notEqual(process.env.UPDATE_GOLDEN, "1");
  });
});
