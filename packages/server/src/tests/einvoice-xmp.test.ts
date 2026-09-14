import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  documentIdXmp,
  documentUuid,
  dublinCoreXmp,
  FACTURX_EXTENSION_SCHEMA_XMP,
  FACTURX_NAMESPACE,
  facturxPropertiesXmp,
} from "../services/einvoice/xmp.js";
import { assertWellFormedXml } from "./support/xml-well-formed.js";

/**
 * The extension schema block of Factur-X 1.07.2 §6.3, as the research copied it.
 * Checked in here rather than derived, so an edit to the module is a visible diff
 * against the spec text.
 */
const SPEC_EXTENSION_SCHEMA = `
<rdf:Description rdf:about=""
    xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
  <pdfaExtension:schemas>
    <rdf:Bag>
      <rdf:li rdf:parseType="Resource">
        <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
        <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
        <pdfaSchema:prefix>fx</pdfaSchema:prefix>
        <pdfaSchema:property>
          <rdf:Seq>
            <rdf:li rdf:parseType="Resource">
              <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
              <pdfaProperty:valueType>Text</pdfaProperty:valueType>
              <pdfaProperty:category>external</pdfaProperty:category>
              <pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description>
            </rdf:li>
            <rdf:li rdf:parseType="Resource">
              <pdfaProperty:name>DocumentType</pdfaProperty:name>
              <pdfaProperty:valueType>Text</pdfaProperty:valueType>
              <pdfaProperty:category>external</pdfaProperty:category>
              <pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description>
            </rdf:li>
            <rdf:li rdf:parseType="Resource">
              <pdfaProperty:name>Version</pdfaProperty:name>
              <pdfaProperty:valueType>Text</pdfaProperty:valueType>
              <pdfaProperty:category>external</pdfaProperty:category>
              <pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description>
            </rdf:li>
            <rdf:li rdf:parseType="Resource">
              <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
              <pdfaProperty:valueType>Text</pdfaProperty:valueType>
              <pdfaProperty:category>external</pdfaProperty:category>
              <pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description>
            </rdf:li>
          </rdf:Seq>
        </pdfaSchema:property>
      </rdf:li>
    </rdf:Bag>
  </pdfaExtension:schemas>
</rdf:Description>`;

const normalise = (xml: string): string => xml.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

/** Wrap a description in the namespaces a packet declares, so it can be checked on its own. */
const inPacket = (description: string): string =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta>`;

describe("Factur-X XMP", () => {
  it("declares the fx extension schema exactly as the spec writes it", () => {
    assert.equal(normalise(FACTURX_EXTENSION_SCHEMA_XMP), normalise(SPEC_EXTENSION_SCHEMA));
  });

  it("keeps the trailing # on the namespace", () => {
    assert.equal(FACTURX_NAMESPACE, "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#");
  });

  it("writes the four fx properties for the EN 16931 profile", () => {
    const xmp = facturxPropertiesXmp();
    assert.match(xmp, /<fx:DocumentType>INVOICE<\/fx:DocumentType>/);
    assert.match(xmp, /<fx:DocumentFileName>factur-x\.xml<\/fx:DocumentFileName>/);
    assert.match(xmp, /<fx:Version>1\.0<\/fx:Version>/);
    assert.match(xmp, /<fx:ConformanceLevel>EN 16931<\/fx:ConformanceLevel>/);
    assert.ok(xmp.includes(`xmlns:fx="${FACTURX_NAMESPACE}"`));
  });

  it("escapes Dublin Core values and collapses newlines", () => {
    const xmp = dublinCoreXmp({
      title: "Invoice 2026-0042",
      creator: `Smith & Co <GmbH> "Ö"\nBerlin`,
      description: "Invoice 2026-0042 to A & B",
    });
    assert.ok(xmp.includes("Smith &amp; Co &lt;GmbH&gt;"));
    assert.ok(xmp.includes("Ö"));
    assert.ok(xmp.includes("A &amp; B"));
    assert.ok(!xmp.includes("\nBerlin"));
  });

  it("produces well-formed XML for every block", () => {
    for (const block of [
      FACTURX_EXTENSION_SCHEMA_XMP,
      facturxPropertiesXmp(),
      dublinCoreXmp({ title: "<&>", creator: `"'`, description: "ä" }),
      documentIdXmp(documentUuid("inv-1", Buffer.from("<x/>"))),
    ]) {
      assertWellFormedXml(inPacket(block));
    }
  });
});

describe("documentUuid", () => {
  const xml = Buffer.from("<rsm:CrossIndustryInvoice/>", "utf8");

  it("is stable for the same invoice and XML", () => {
    assert.equal(documentUuid("inv-1", xml), documentUuid("inv-1", Buffer.from(xml)));
  });

  it("changes when one byte of the XML changes, or the invoice id does", () => {
    const changed = Buffer.from(xml);
    changed[5] = (changed[5] ?? 0) ^ 1;
    assert.notEqual(documentUuid("inv-1", xml), documentUuid("inv-1", changed));
    assert.notEqual(documentUuid("inv-1", xml), documentUuid("inv-2", xml));
  });

  it("is an RFC 9562 version 8 UUID", () => {
    const uuid = documentUuid("inv-1", xml);
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(documentIdXmp(uuid).includes(`<xmpMM:DocumentID>uuid:${uuid}</xmpMM:DocumentID>`));
  });
});
