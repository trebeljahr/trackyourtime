/**
 * Byte-level readers for the PDFs pdfkit writes, for tests only.
 *
 * pdfkit writes every indirect object as `N 0 obj\n<<…>>\n[stream\n…\nendstream\n]endobj`
 * with a direct `/Length`, so objects can be read without a PDF library: find
 * each `obj`, take its dictionary, and cut the stream by its declared length.
 * This is not a general PDF parser and does not try to be one.
 */
import { inflateSync } from "node:zlib";

export type PdfObject = {
  num: number;
  /** The dictionary source, latin1, including `<<` and `>>`. Empty for non-dictionary objects. */
  dict: string;
  /** Raw (possibly compressed) stream bytes, or null when the object has no stream. */
  stream: Buffer | null;
};

const OBJ_HEADER = /(\d+) 0 obj\n/g;

/** Every indirect object in file order. */
export function pdfObjects(bytes: Buffer): PdfObject[] {
  const text = bytes.toString("latin1");
  const objects: PdfObject[] = [];
  OBJ_HEADER.lastIndex = 0;
  for (let match = OBJ_HEADER.exec(text); match !== null; match = OBJ_HEADER.exec(text)) {
    const bodyStart = match.index + match[0].length;
    const streamAt = text.indexOf("\nstream\n", bodyStart);
    const endObjAt = text.indexOf("endobj", bodyStart);
    const hasStream = streamAt !== -1 && (endObjAt === -1 || streamAt < endObjAt);
    const dictEnd = hasStream ? streamAt : endObjAt;
    const dict = text.slice(bodyStart, dictEnd).trim();

    let stream: Buffer | null = null;
    if (hasStream) {
      const length = /\/Length (\d+)/.exec(dict);
      const start = streamAt + "\nstream\n".length;
      const end =
        length?.[1] !== undefined
          ? start + Number(length[1])
          : text.indexOf("\nendstream", start);
      stream = bytes.subarray(start, end);
      OBJ_HEADER.lastIndex = end;
    }
    objects.push({ num: Number(match[1]), dict, stream });
  }
  return objects;
}

/** The decoded stream: inflated when the dictionary says FlateDecode. */
export function decodedStream(object: PdfObject): Buffer {
  if (object.stream === null) throw new Error(`object ${object.num} has no stream`);
  return object.dict.includes("/Filter /FlateDecode")
    ? inflateSync(object.stream)
    : Buffer.from(object.stream);
}

/** Every object that carries a stream. */
export function streams(bytes: Buffer): PdfObject[] {
  return pdfObjects(bytes).filter((object) => object.stream !== null);
}

/** The document's XMP packet (the `/Type /Metadata` stream), as UTF-8. Null when there is none. */
export function xmpPacket(bytes: Buffer): string | null {
  const object = pdfObjects(bytes).find((candidate) =>
    candidate.dict.includes("/Type /Metadata"),
  );
  return object ? decodedStream(object).toString("utf8") : null;
}

/** The embedded files: each `/Type /EmbeddedFile` stream, decoded, with its dictionary. */
export function embeddedFiles(bytes: Buffer): { dict: string; data: Buffer }[] {
  return pdfObjects(bytes)
    .filter((object) => object.dict.includes("/Type /EmbeddedFile"))
    .map((object) => ({ dict: object.dict, data: decodedStream(object) }));
}

/**
 * The document Info dictionary as key → value source, with indirect values
 * (`/Producer 13 0 R`, which is how pdfkit writes them) resolved to the
 * referenced object's body, e.g. `Producer → "(Track Your Time)"`.
 */
export function infoEntries(bytes: Buffer): Map<string, string> {
  const text = bytes.toString("latin1");
  const trailer = text.slice(text.lastIndexOf("trailer"));
  const ref = /\/Info (\d+) 0 R/.exec(trailer);
  if (ref?.[1] === undefined) throw new Error("no /Info in trailer");
  const objects = new Map(pdfObjects(bytes).map((object) => [object.num, object]));
  const info = objects.get(Number(ref[1]));
  if (!info) throw new Error(`/Info object ${ref[1]} not found`);

  const entries = new Map<string, string>();
  for (const match of info.dict.matchAll(/\/(\w+) (\d+ 0 R|\([^)]*\)|<[^>]*>)/g)) {
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    const indirect = /^(\d+) 0 R$/.exec(value);
    entries.set(
      key,
      indirect?.[1] !== undefined ? (objects.get(Number(indirect[1]))?.dict ?? "") : value,
    );
  }
  return entries;
}

/**
 * The visible text of each page of a PDF drawn with the standard-14 fonts, in
 * page order: pdfkit writes each run as hex inside `TJ` arrays, split where
 * kerning fires, so concatenating every `<hex>` run in a content stream
 * reassembles the characters that page draws. (An embedded-font PDF writes
 * glyph ids instead, which this does not decode.)
 */
export function pageTexts(bytes: Buffer): string[] {
  const pages: string[] = [];
  const open = Buffer.from("stream\n", "latin1");
  const close = Buffer.from("endstream", "latin1");

  let cursor = 0;
  for (;;) {
    const at = bytes.indexOf(open, cursor);
    if (at === -1) break;
    const start = at + open.byteLength;
    const end = bytes.indexOf(close, start);
    if (end === -1) break;

    try {
      const inflated = inflateSync(bytes.subarray(start, end)).toString("latin1");
      const runs = inflated.match(/<([0-9a-fA-F]+)>/g) ?? [];
      const hex = runs.map((run) => run.slice(1, -1)).join("");
      pages.push(Buffer.from(hex, "hex").toString("latin1"));
      cursor = end + close.byteLength;
    } catch {
      cursor = start;
    }
  }

  return pages;
}
