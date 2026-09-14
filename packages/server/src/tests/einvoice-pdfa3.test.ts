import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EinvoiceProfile, Invoice } from "@starter/shared";
import { buildCiiXml } from "../services/einvoice/cii.js";
import { coverInvoiceText } from "../services/einvoice/glyph-coverage.js";
import { renderZugferdPdf, zugferdPdfFilename } from "../services/einvoice/pdfa3.js";
import { assertEinvoiceReady } from "../services/einvoice/validate.js";
import { loadPdfFonts } from "../services/pdf-fonts.js";
import { EINVOICE_CASES, einvoiceCase } from "./fixtures/einvoice/cases.js";
import { embeddedFiles, infoEntries, xmpPacket } from "./support/pdf-bytes.js";
import { assertWellFormedXml } from "./support/xml-well-formed.js";

const GENERATED_AT = "2026-10-01T10:00:00.000Z";
const PROFILE: EinvoiceProfile = "en16931";

type Rendered = { invoice: Invoice; xml: string; bytes: Buffer; raw: string };

async function render(invoice: Invoice): Promise<Rendered> {
  const ready = assertEinvoiceReady(invoice, PROFILE);
  const xml = buildCiiXml(ready, PROFILE);
  const bytes = await renderZugferdPdf(ready, xml, { generatedAt: GENERATED_AT });
  return { invoice, xml, bytes, raw: bytes.toString("latin1") };
}

const pageCount = (raw: string): number => raw.match(/\/Type \/Page\n/g)?.length ?? 0;

/** Every structural property the PDF/A-3b + Factur-X container must have, on raw bytes. */
function assertHybridContainer({ invoice, xml, bytes, raw }: Rendered): void {
  assert.equal(raw.slice(0, 8), "%PDF-1.7");
  assert.ok(raw.includes("/ID [<"), "trailer /ID");
  assert.ok(raw.trimEnd().endsWith("%%EOF"));

  for (const marker of [
    "/OutputIntents",
    "/S /GTS_PDFA1",
    "/EmbeddedFiles",
    "/AF [",
    "/AFRelationship /Alternative",
    "/Subtype /text#2Fxml",
    "/F (factur-x.xml)",
    "/UF (factur-x.xml)",
    "/FontFile2",
    "/Metadata",
  ]) {
    assert.ok(raw.includes(marker), `missing ${marker}`);
  }

  // No standard-14 font may reach the file: PDF/A requires every font embedded.
  const baseFonts = [...raw.matchAll(/\/BaseFont \/([^\s/>]+)/g)].map((match) => match[1]);
  assert.ok(baseFonts.length > 0);
  for (const name of baseFonts) {
    assert.match(name ?? "", /^[A-Z]{6}\+NotoSans-(Regular|Bold)$/, `unembedded font ${name}`);
  }
  assert.ok(!raw.includes("/BaseFont /Helvetica") && !raw.includes("/BaseFont /Times"));

  for (const forbidden of ["/Encrypt", "/JavaScript", "/AA "]) {
    assert.ok(!raw.includes(forbidden), `forbidden ${forbidden}`);
  }

  const info = infoEntries(bytes);
  assert.equal(info.has("Title"), false, "Info must carry no Title (pdfkit writes it into XMP unescaped)");
  assert.equal(info.get("Producer"), "(Track Your Time)");
  assert.equal(info.get("Creator"), "(Track Your Time)");

  const xmp = xmpPacket(bytes);
  assert.ok(xmp !== null, "no XMP packet");
  for (const marker of [
    "<pdfaid:part>3</pdfaid:part>",
    "<pdfaid:conformance>B</pdfaid:conformance>",
    "<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>",
    "<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>",
    "<fx:DocumentType>INVOICE</fx:DocumentType>",
    "<fx:Version>1.0</fx:Version>",
    "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#",
    "<xmpMM:DocumentID>uuid:",
  ]) {
    assert.ok(xmp.includes(marker), `XMP lacks ${marker}`);
  }
  const header = /<\?xpacket begin=[^?]*\?>/.exec(xmp)?.[0] ?? "";
  assert.ok(header !== "", "no xpacket header");
  assert.ok(!header.includes("bytes=") && !header.includes("encoding="), header);
  assertWellFormedXml(xmp.replace(/<\?xpacket[^?]*\?>/g, "").trim());

  const escapedSeller = (invoice.issuer?.legalName ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  assert.ok(xmp.includes(`<rdf:li>${escapedSeller}</rdf:li>`), "dc:creator is the seller");

  const files = embeddedFiles(bytes);
  assert.equal(files.length, 1);
  const [file] = files;
  const expected = Buffer.from(xml, "utf8");
  assert.ok(file !== undefined);
  assert.ok(file.data.equals(expected), "embedded factur-x.xml must be the XML byte for byte");
  assert.ok(file.dict.includes(`/Size ${expected.byteLength}`), "/Params /Size");
}

describe("renderZugferdPdf", () => {
  const cases = EINVOICE_CASES.filter((c) => c.name !== "long-500");

  for (const c of cases) {
    it(`${c.name}: is a PDF/A-3b container with factur-x.xml embedded`, async () => {
      assertHybridContainer(await render(c.invoice()));
    });
  }

  it("escapes an ampersand seller name into the XMP and keeps it well-formed", async () => {
    const base = einvoiceCase("standard-19").invoice();
    const invoice: Invoice = base.issuer
      ? { ...base, issuer: { ...base.issuer, legalName: `Smith & Co <GmbH> "Ö"` } }
      : base;
    const rendered = await render(invoice);
    assertHybridContainer(rendered);
    assert.ok(rendered.raw.includes("Smith &amp; Co &lt;GmbH&gt;"));
  });

  it("renders a character the font lacks as ? on the page, while the XML keeps it", async () => {
    const invoice = einvoiceCase("escaping").invoice();
    const covered = coverInvoiceText(invoice, loadPdfFonts().hasGlyph);
    const labels = invoice.lineItems.map((line) => line.label).join("\n");
    assert.ok(labels.includes("😀"), "the fixture must carry an emoji");
    assert.ok(!covered.lineItems.map((line) => line.label).join("\n").includes("😀"));
    assert.ok(covered.lineItems.map((line) => line.label).join("\n").includes("?"));

    const rendered = await render(invoice);
    assert.ok(rendered.xml.includes("😀"));
  });

  it("is deterministic for a fixed generatedAt", async () => {
    const invoice = einvoiceCase("reduced-7").invoice();
    const first = await render(invoice);
    const second = await render(einvoiceCase("reduced-7").invoice());
    assert.equal(first.bytes.byteLength, second.bytes.byteLength);
    const id = (raw: string): string | undefined => /\/ID \[<([0-9a-f]+)>/.exec(raw)?.[1];
    assert.equal(id(first.raw), id(second.raw));
    assert.equal(xmpPacket(first.bytes), xmpPacket(second.bytes));
  });

  it("does not mutate the invoice it renders", async () => {
    const invoice = einvoiceCase("escaping").invoice();
    const before = structuredClone(invoice);
    await render(invoice);
    assert.deepEqual(invoice, before);
  });

  it("refuses an invalid generatedAt instead of stamping a wrong date", async () => {
    const invoice = assertEinvoiceReady(einvoiceCase("standard-19").invoice(), PROFILE);
    await assert.rejects(
      renderZugferdPdf(invoice, buildCiiXml(invoice, PROFILE), { generatedAt: "not a date" }),
      RangeError,
    );
  });

  it("long-500: paginates 500 lines and stays fast", async () => {
    const started = performance.now();
    const rendered = await render(einvoiceCase("long-500").invoice());
    const elapsed = performance.now() - started;
    assertHybridContainer(rendered);
    assert.ok(pageCount(rendered.raw) > 1, "expected more than one page");
    assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
  });
});

describe("zugferdPdfFilename", () => {
  it("sanitises the invoice number", () => {
    assert.equal(zugferdPdfFilename("2026/0042"), "invoice-2026-0042-zugferd.pdf");
    assert.equal(zugferdPdfFilename("../"), "invoice-document-zugferd.pdf");
  });
});
