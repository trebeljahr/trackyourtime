// Profile pictures: what bytes are accepted, where they are served, and the
// headers that let another origin's <img> load them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import helmet from "helmet";
import { AVATAR_REFUSALS, MAX_AVATAR_BYTES } from "@starter/shared";
import {
  avatarUrl,
  decodeAvatar,
  parseAvatarPath,
  sniffImageType,
} from "../services/avatar/image.js";
import { registerAvatarRoutes, type AvatarLookup } from "../services/avatar/route.js";
import { userScopedSteps } from "../services/account-deletion/plan.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
]);
const KEY = "0123456789abcdef0123456789abcdef";

describe("sniffImageType", () => {
  it("names JPEG, PNG and WebP by their magic numbers", () => {
    assert.equal(sniffImageType(JPEG), "image/jpeg");
    assert.equal(sniffImageType(PNG), "image/png");
    assert.equal(sniffImageType(WEBP), "image/webp");
  });

  it("refuses everything else, SVG and GIF included", () => {
    assert.equal(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(sniffImageType(Buffer.from("GIF89a")), null);
    assert.equal(sniffImageType(Buffer.from("RIFF....WAVE")), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });
});

describe("decodeAvatar", () => {
  it("accepts a small JPEG and reports its type from the bytes", () => {
    const decoded = decodeAvatar(JPEG.toString("base64"));
    assert.ok(decoded.ok);
    assert.equal(decoded.contentType, "image/jpeg");
    assert.deepEqual(decoded.bytes, JPEG);
  });

  it("refuses malformed base64", () => {
    assert.deepEqual(decodeAvatar("not base64!"), {
      ok: false,
      refusal: AVATAR_REFUSALS.INVALID_DATA,
    });
    assert.deepEqual(decodeAvatar("QUJD"), {
      ok: false,
      refusal: AVATAR_REFUSALS.UNSUPPORTED_IMAGE,
    });
  });

  it("refuses a data-URL prefix rather than decoding around it", () => {
    const decoded = decodeAvatar(`data:image/jpeg;base64,${JPEG.toString("base64")}`);
    assert.deepEqual(decoded, { ok: false, refusal: AVATAR_REFUSALS.INVALID_DATA });
  });

  it("refuses bytes over the ceiling before looking at them", () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_AVATAR_BYTES)]);
    assert.deepEqual(decodeAvatar(big.toString("base64")), {
      ok: false,
      refusal: AVATAR_REFUSALS.TOO_LARGE,
    });
  });

  it("refuses an image type it does not serve", () => {
    assert.deepEqual(decodeAvatar(Buffer.from("GIF89a....").toString("base64")), {
      ok: false,
      refusal: AVATAR_REFUSALS.UNSUPPORTED_IMAGE,
    });
  });
});

describe("avatarUrl / parseAvatarPath", () => {
  it("builds an absolute address under the API origin", () => {
    assert.equal(
      avatarUrl("https://api.example.test/", "u1", KEY),
      `https://api.example.test/api/avatars/u1/${KEY}`,
    );
  });

  it("accepts only ids and keys of the shape it produces", () => {
    assert.deepEqual(parseAvatarPath("u1", KEY), { userId: "u1", key: KEY });
    assert.equal(parseAvatarPath("u1", "short"), null);
    assert.equal(parseAvatarPath("u1", KEY.toUpperCase()), null);
    assert.equal(parseAvatarPath("../u1", KEY), null);
    assert.equal(parseAvatarPath(undefined, KEY), null);
  });
});

describe("GET /api/avatars/:userId/:key", () => {
  let server: Server;
  let base: string;
  const lookup: AvatarLookup = async (userId, key) =>
    userId === "alice" && key === KEY
      ? { contentType: "image/png", size: PNG.length, bytes: PNG }
      : null;

  before(async () => {
    const app = express();
    // The real app mounts helmet first; the route must override its
    // Cross-Origin-Resource-Policy or no other origin can load the picture.
    app.use(helmet());
    registerAvatarRoutes(app, lookup);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves the bytes as an immutable, cross-origin-loadable image", async () => {
    const response = await fetch(`${base}/api/avatars/alice/${KEY}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(PNG.length));
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-disposition"), "inline");
    assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'none'"));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });

  it("answers HEAD with the headers and no body", async () => {
    const response = await fetch(`${base}/api/avatars/alice/${KEY}`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  it("is 404 for a wrong key, a wrong user or a malformed path", async () => {
    for (const path of [
      `/api/avatars/alice/${KEY.replace("0", "f")}`,
      `/api/avatars/bob/${KEY}`,
      `/api/avatars/alice/nope`,
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
    }
  });
});

describe("account deletion", () => {
  it("removes the stored picture with the user's other rows", () => {
    const steps = userScopedSteps({ id: "u1", email: "a@example.test" });
    assert.ok(steps.some((step) => step.collection === "avatars"));
  });
});
