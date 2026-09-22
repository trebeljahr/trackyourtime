/**
 * Writes the e-invoice fixture matrix to disk, through the real serializer
 * and PDF renderer, for `pnpm einvoice:validate` to run through the Java
 * validators.
 *
 *   pnpm --filter @starter/server run einvoice:samples -- --out <dir> [--only <case>]
 *
 * For every case (or `--only`): `<case>.<profile>.xml` for the case's
 * profiles and `<case>.zugferd.pdf` with the en16931 XML embedded.
 *
 * It refuses (exit 1) when a generated XML differs from its committed golden
 * file, so the validators can never pass on output the unit tests reject.
 * No database, no env, no network: fixtures and pure services only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EinvoiceProfile } from "@starter/shared";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { renderZugferdPdf } from "../services/einvoice/pdfa3.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";
import { inspectLogoBytes, type StoredLogo } from "../services/invoice-logo.js";
import { EINVOICE_CASES, fixturePath } from "../tests/fixtures/einvoice/cases.js";

/** Fixed so every run writes byte-identical PDFs. */
export const SAMPLES_GENERATED_AT = "2026-10-01T10:00:00.000Z";

export type SamplesOptions = {
  out: string;
  only?: string;
  /** Called once per written file. Defaults to printing the path. */
  log?: (line: string) => void;
};

export type SamplesResult = {
  /** Absolute paths, in write order. */
  files: string[];
};

export class GoldenMismatchError extends Error {
  override readonly name = "GoldenMismatchError";
}

export async function main(options: SamplesOptions): Promise<SamplesResult> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const cases = EINVOICE_CASES.filter((c) => options.only === undefined || c.name === options.only);
  if (cases.length === 0) throw new Error(`unknown e-invoice case: ${options.only ?? ""}`);

  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const write = (name: string, data: string | Buffer): void => {
    const file = join(out, name);
    writeFileSync(file, data);
    files.push(file);
    log(file);
  };

  for (const c of cases) {
    for (const profile of c.profiles) {
      const xml = buildCiiXml(assertEinvoiceReady(c.invoice(), profile), profile);
      const golden = fixturePath(`${c.name}.${profile}.xml`);
      if (!existsSync(golden) || readFileSync(golden, "utf8") !== xml) {
        throw new GoldenMismatchError(
          `${c.name}.${profile}.xml differs from its golden file: run the unit tests (UPDATE_GOLDEN=1 to regenerate) before validating`,
        );
      }
      write(`${c.name}.${profile}.xml`, xml);
    }

    const profile: EinvoiceProfile = "en16931";
    const ready = assertEinvoiceReady(c.invoice(), profile);
    const xml = buildCiiXml(ready, profile);
    write(`${c.name}.zugferd.pdf`, await renderZugferdPdf(ready, xml, { generatedAt: SAMPLES_GENERATED_AT }));

    // One PDF with the issuer logo frozen on it, so veraPDF checks the image
    // XObject and its /SMask (PNG alpha) inside the PDF/A-3b container. The
    // same XML: the logo is drawn, never serialised.
    if (c.name === LOGO_SAMPLE_CASE) {
      const frozen = { ...ready, issuer: { ...ready.issuer, logo: sampleLogo() } };
      write(logoSampleName(c.name), await renderZugferdPdf(frozen, xml, { generatedAt: SAMPLES_GENERATED_AT }));
    }
  }
  return { files };
}

/** The case that also gets a `-logo` PDF. */
export const LOGO_SAMPLE_CASE = "standard-19";

export const logoSampleName = (caseName: string): string => `${caseName}-logo.zugferd.pdf`;

function sampleLogo(): StoredLogo {
  const inspected = inspectLogoBytes(readFileSync(fixturePath("logo.png")));
  if (!inspected.ok) throw new Error(`fixtures/einvoice/logo.png refused: ${inspected.refusal}`);
  return inspected.logo;
}

function parseArgs(argv: readonly string[]): SamplesOptions {
  let out: string | undefined;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--out") out = argv[++i];
    else if (arg === "--only") only = argv[++i];
    else throw new Error(`unknown argument: ${arg ?? ""}`);
  }
  if (out === undefined || out === "") throw new Error("usage: einvoice-samples --out <dir> [--only <case>]");
  return only === undefined ? { out } : { out, only };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
