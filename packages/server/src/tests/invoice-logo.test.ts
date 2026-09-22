// What a business logo may be: the byte checks in `services/invoice-logo.ts`
// over real files, and — because the checks exist to keep pdfkit from
// producing something an invoice cannot carry — each verdict held against
// pdfkit itself: every accepted fixture embeds as an image XObject, and each
// refusal names the pdfkit behaviour it keeps out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import {
  BUSINESS_LOGO_MAX_BYTES,
  BUSINESS_LOGO_MAX_DIMENSION,
  BUSINESS_LOGO_REFUSALS,
  businessLogoRefusalOf,
  parseImageDataUrl,
} from "@starter/shared";
import {
  inspectLogoBytes,
  inspectLogoUpload,
  logoToWire,
  sniffLogoMime,
  storedLogoOf,
} from "../services/invoice-logo.js";

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/logo/${name}`, import.meta.url)));

/** What pdfkit writes for the bytes: the image XObject dictionaries, or the throw. */
async function embed(bytes: Buffer): Promise<{ xobjects: string[] } | { error: string }> {
  try {
    const doc = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      doc.on("end", () => resolve());
      doc.on("error", reject);
    });
    doc.image(bytes, 48, 48, { fit: [160, 60] });
    doc.end();
    await done;
    const raw = Buffer.concat(chunks).toString("latin1");
    return { xobjects: raw.match(/\/Subtype \/Image[^>]*/g) ?? [] };
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error) };
  }
}

const accepted = (name: string) => {
  const result = inspectLogoBytes(fixture(name));
  assert.ok(result.ok, `${name} refused: ${result.ok ? "" : result.refusal}`);
  return result.logo;
};

describe("inspectLogoBytes: accepted files", () => {
  it("reads a PNG's size out of IHDR and a JPEG's out of SOF", () => {
    for (const name of ["rgb.png", "rgba.png", "palette.png", "gray.png", "gray16.png"]) {
      const logo = accepted(name);
      assert.equal(logo.mime, "image/png", name);
      assert.deepEqual([logo.width, logo.height], [48, 16], name);
    }
    for (const name of ["rgb.jpg", "gray.jpg", "progressive.jpg"]) {
      const logo = accepted(name);
      assert.equal(logo.mime, "image/jpeg", name);
      assert.deepEqual([logo.width, logo.height], [48, 16], name);
    }
  });

  it("stores the bytes unchanged with their SHA-256", () => {
    const bytes = fixture("rgb.png");
    const logo = accepted("rgb.png");
    assert.ok(logo.data.equals(bytes));
    assert.equal(logo.sha256, createHash("sha256").update(bytes).digest("hex"));
  });

  it("every accepted fixture embeds in pdfkit as an image XObject", async () => {
    const expectedColorSpace: Record<string, string> = {
      "rgb.png": "/DeviceRGB",
      "rgba.png": "/SMask",
      "palette.png": "/Indexed",
      "gray.png": "/DeviceGray",
      "gray16.png": "/BitsPerComponent 16",
      "rgb.jpg": "/DeviceRGB",
      "gray.jpg": "/DeviceGray",
      "progressive.jpg": "/DCTDecode",
    };
    for (const [name, marker] of Object.entries(expectedColorSpace)) {
      accepted(name);
      const result = await embed(fixture(name));
      assert.ok("xobjects" in result, `${name}: ${"error" in result ? result.error : ""}`);
      assert.ok(result.xobjects.length >= 1, name);
      assert.ok(result.xobjects.some((dict) => dict.includes(marker)), `${name} lacks ${marker}`);
    }
  });

  it("accepts the declared type when it matches the bytes", () => {
    assert.ok(inspectLogoBytes(fixture("rgb.png"), "image/png").ok);
    assert.ok(inspectLogoBytes(fixture("rgb.jpg"), "image/jpeg").ok);
  });
});

describe("inspectLogoBytes: refusals", () => {
  const refused = (name: string, refusal: string, declared?: "image/png" | "image/jpeg") => {
    const result = inspectLogoBytes(fixture(name), declared);
    assert.equal(result.ok, false, `${name} was accepted`);
    if (!result.ok) assert.equal(result.refusal, refusal, name);
  };

  it("refuses what pdfkit cannot open at all: SVG, WebP, and a renamed file", async () => {
    refused("logo.svg", BUSINESS_LOGO_REFUSALS.unsupportedFormat);
    refused("rgb.webp", BUSINESS_LOGO_REFUSALS.unsupportedFormat);
    // The bytes decide, not the declared type.
    refused("rgb.webp", BUSINESS_LOGO_REFUSALS.unsupportedFormat, "image/png");
    refused("rgb.png", BUSINESS_LOGO_REFUSALS.unsupportedFormat, "image/jpeg");
    for (const name of ["logo.svg", "rgb.webp"]) {
      const result = await embed(fixture(name));
      assert.ok("error" in result && /Unknown image format/.test(result.error), name);
    }
  });

  it("refuses an interlaced PNG, which pdfkit rebuilds from decoded pixels instead of copying", async () => {
    refused("interlaced.png", BUSINESS_LOGO_REFUSALS.interlacedPng);
    refused("interlaced-alpha.png", BUSINESS_LOGO_REFUSALS.interlacedPng);
    // pdfkit does not throw on it; the refusal is a policy, so the fact the
    // policy rests on is pinned: the plain PNG keeps the file's own predictor
    // (15), the interlaced one is re-encoded with none (Predictor 1).
    const plain = await embed(fixture("rgb.png"));
    assert.ok("xobjects" in plain);
    const interlaced = await embed(fixture("interlaced.png"));
    assert.ok("xobjects" in interlaced);
    const raw = (bytes: Buffer) =>
      new Promise<string>((resolve) => {
        const doc = new PDFDocument({ size: "A4" });
        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
        doc.image(bytes, 48, 48);
        doc.end();
      });
    assert.match(await raw(fixture("rgb.png")), /\/Predictor 15/);
    assert.match(await raw(fixture("interlaced.png")), /\/Predictor 1\b/);
  });

  it("refuses a CMYK JPEG, which pdfkit embeds as /DeviceCMYK (forbidden beside PDF/A's sRGB intent)", async () => {
    refused("cmyk.jpg", BUSINESS_LOGO_REFUSALS.cmykJpeg);
    const result = await embed(fixture("cmyk.jpg"));
    assert.ok("xobjects" in result && result.xobjects.some((dict) => dict.includes("/DeviceCMYK")));
  });

  it("refuses JPEG frames DCTDecode viewers do not read: 12-bit, lossless, arithmetic", () => {
    const rgb = fixture("rgb.jpg");
    const sofAt = rgb.indexOf(Buffer.from([0xff, 0xc0]));
    assert.ok(sofAt > 0);
    const twelveBit = Buffer.from(rgb);
    twelveBit[sofAt + 4] = 12;
    assert.deepEqual(inspectLogoBytes(twelveBit), { ok: false, refusal: BUSINESS_LOGO_REFUSALS.unsupportedJpeg });
    for (const marker of [0xc3, 0xc9]) {
      const other = Buffer.from(rgb);
      other[sofAt + 1] = marker;
      assert.deepEqual(inspectLogoBytes(other), { ok: false, refusal: BUSINESS_LOGO_REFUSALS.unsupportedJpeg });
    }
  });

  it("refuses over the byte cap and over the pixel cap", () => {
    const big = Buffer.concat([fixture("rgb.png"), Buffer.alloc(BUSINESS_LOGO_MAX_BYTES)]);
    assert.deepEqual(inspectLogoBytes(big), { ok: false, refusal: BUSINESS_LOGO_REFUSALS.tooLarge });
    // 2001 px wide in 149 bytes: a flat colour compresses to nothing, which
    // is exactly why the cap is on pixels and not only on bytes.
    assert.ok(fixture("too-wide.png").length < 1024);
    refused("too-wide.png", BUSINESS_LOGO_REFUSALS.tooBig);
    assert.equal(BUSINESS_LOGO_MAX_DIMENSION, 2000);
  });

  it("refuses a truncated or malformed header as corrupt", () => {
    assert.deepEqual(inspectLogoBytes(fixture("rgb.png").subarray(0, 20)), {
      ok: false,
      refusal: BUSINESS_LOGO_REFUSALS.corrupt,
    });
    const zeroWidth = Buffer.from(fixture("rgb.png"));
    zeroWidth.writeUInt32BE(0, 16);
    assert.deepEqual(inspectLogoBytes(zeroWidth), { ok: false, refusal: BUSINESS_LOGO_REFUSALS.corrupt });
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    assert.deepEqual(inspectLogoBytes(noFrame), { ok: false, refusal: BUSINESS_LOGO_REFUSALS.corrupt });
    assert.equal(sniffLogoMime(Buffer.alloc(0)), null);
  });
});

describe("inspectLogoUpload, storedLogoOf and logoToWire", () => {
  it("decodes the upload body and round-trips through the data URL", () => {
    const bytes = fixture("rgba.png");
    const result = inspectLogoUpload({ mime: "image/png", base64: bytes.toString("base64") });
    assert.ok(result.ok);
    const wire = logoToWire(result.logo);
    assert.deepEqual([wire.width, wire.height], [48, 16]);
    assert.deepEqual(parseImageDataUrl(wire.dataUrl), { mime: "image/png", base64: bytes.toString("base64") });
    assert.deepEqual(inspectLogoUpload({ mime: "image/png", base64: "" }), {
      ok: false,
      refusal: BUSINESS_LOGO_REFUSALS.corrupt,
    });
  });

  it("reads a stored row whether the driver hands back a Buffer or a Binary", () => {
    const bytes = fixture("rgb.jpg");
    const asBuffer = storedLogoOf({ mime: "image/jpeg", data: bytes, width: 48, height: 16, sha256: "abc" });
    assert.equal(asBuffer?.sha256, "abc");
    assert.ok(asBuffer?.data.equals(bytes));
    const asBinary = storedLogoOf({ mime: "image/jpeg", data: { buffer: bytes }, width: 48, height: 16 });
    assert.equal(asBinary?.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(storedLogoOf(null), null);
    assert.equal(storedLogoOf({ mime: "image/gif", data: bytes, width: 1, height: 1 }), null);
    assert.equal(storedLogoOf({ mime: "image/png", data: Buffer.alloc(0), width: 1, height: 1 }), null);
  });

  it("names every refusal code as a stable message", () => {
    for (const code of Object.values(BUSINESS_LOGO_REFUSALS)) {
      assert.equal(businessLogoRefusalOf(code), code);
    }
    assert.equal(businessLogoRefusalOf("Invoice not found"), null);
  });
});
