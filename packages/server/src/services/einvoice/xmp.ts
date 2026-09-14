/**
 * The XMP blocks the ZUGFeRD / Factur-X PDF appends to pdfkit's metadata packet.
 *
 * pdfkit writes `pdfaid` (from `subset: "PDF/A-3b"`), `xmp:CreateDate`,
 * `xmp:CreatorTool` and `pdf:Producer` itself. Everything else is here, as pure
 * strings, each one an `rdf:Description` handed to `doc.appendXML`:
 *
 * - the Dublin Core block, escaped. pdfkit would write `info.Title/Author/Subject`
 *   into XMP unescaped, so the PDF/A variant never sets those and uses this;
 * - the PDF/A extension schema declaring the `fx` namespace. veraPDF rejects an
 *   XMP property whose schema is not declared inside the same packet;
 * - the `fx:` properties themselves;
 * - `xmpMM:DocumentID`, stable for one invoice and one XML.
 */
import { createHash } from "node:crypto";
import { FACTURX_XMP } from "./constants.js";
import { cleanLine } from "./format.js";
import { escapeXml } from "./xml.js";

/** Factur-X 1.0 extension schema namespace. The trailing `#` is part of the URI. */
export const FACTURX_NAMESPACE = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";

const property = (name: string, description: string): string =>
  [
    `            <rdf:li rdf:parseType="Resource">`,
    `              <pdfaProperty:name>${name}</pdfaProperty:name>`,
    `              <pdfaProperty:valueType>Text</pdfaProperty:valueType>`,
    `              <pdfaProperty:category>external</pdfaProperty:category>`,
    `              <pdfaProperty:description>${description}</pdfaProperty:description>`,
    `            </rdf:li>`,
  ].join("\n");

/** The `pdfaExtension:schemas` description of the `fx` namespace (Factur-X 1.07.2 §6.3). No user data. */
export const FACTURX_EXTENSION_SCHEMA_XMP: string = [
  `<rdf:Description rdf:about=""`,
  `    xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"`,
  `    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"`,
  `    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">`,
  `  <pdfaExtension:schemas>`,
  `    <rdf:Bag>`,
  `      <rdf:li rdf:parseType="Resource">`,
  `        <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>`,
  `        <pdfaSchema:namespaceURI>${FACTURX_NAMESPACE}</pdfaSchema:namespaceURI>`,
  `        <pdfaSchema:prefix>fx</pdfaSchema:prefix>`,
  `        <pdfaSchema:property>`,
  `          <rdf:Seq>`,
  property("DocumentFileName", "The name of the embedded XML document"),
  property(
    "DocumentType",
    "The type of the hybrid document in capital letters, e.g. INVOICE or ORDER",
  ),
  property(
    "Version",
    "The actual version of the standard applying to the embedded XML document",
  ),
  property("ConformanceLevel", "The conformance level of the embedded XML document"),
  `          </rdf:Seq>`,
  `        </pdfaSchema:property>`,
  `      </rdf:li>`,
  `    </rdf:Bag>`,
  `  </pdfaExtension:schemas>`,
  `</rdf:Description>`,
].join("\n");

/** The `fx:` properties: INVOICE, factur-x.xml, 1.0, EN 16931. */
export function facturxPropertiesXmp(): string {
  return [
    `<rdf:Description rdf:about="" xmlns:fx="${FACTURX_NAMESPACE}">`,
    `  <fx:DocumentType>${escapeXml(FACTURX_XMP.documentType)}</fx:DocumentType>`,
    `  <fx:DocumentFileName>${escapeXml(FACTURX_XMP.documentFileName)}</fx:DocumentFileName>`,
    `  <fx:Version>${escapeXml(FACTURX_XMP.version)}</fx:Version>`,
    `  <fx:ConformanceLevel>${escapeXml(FACTURX_XMP.conformanceLevel)}</fx:ConformanceLevel>`,
    `</rdf:Description>`,
  ].join("\n");
}

export type DublinCoreFields = {
  title: string;
  creator: string;
  description: string;
};

/** `dc:title`, `dc:creator`, `dc:description`. Every value is collapsed to one line and escaped. */
export function dublinCoreXmp(fields: DublinCoreFields): string {
  const text = (value: string): string => escapeXml(cleanLine(value));
  return [
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    `  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${text(fields.title)}</rdf:li></rdf:Alt></dc:title>`,
    `  <dc:creator><rdf:Seq><rdf:li>${text(fields.creator)}</rdf:li></rdf:Seq></dc:creator>`,
    `  <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${text(fields.description)}</rdf:li></rdf:Alt></dc:description>`,
    `</rdf:Description>`,
  ].join("\n");
}

/** `xmpMM:DocumentID` (a predefined XMP 2005 schema, so no extension schema is needed). */
export function documentIdXmp(uuid: string): string {
  return [
    `<rdf:Description rdf:about="" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">`,
    `  <xmpMM:DocumentID>uuid:${escapeXml(uuid)}</xmpMM:DocumentID>`,
    `</rdf:Description>`,
  ].join("\n");
}

/**
 * A name-based UUID (RFC 9562 version 8) from the invoice id and the exact XML
 * bytes: the same invoice with the same XML always gets the same id, a re-export
 * of a stored XML keeps it, and a draft whose XML changed gets a new one.
 */
export function documentUuid(invoiceId: string, xmlBytes: Uint8Array): string {
  const digest = createHash("sha256")
    .update(`${invoiceId}\n`, "utf8")
    .update(xmlBytes)
    .digest()
    .subarray(0, 16);
  const bytes = Buffer.from(digest);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
