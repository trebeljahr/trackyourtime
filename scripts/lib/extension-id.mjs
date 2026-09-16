/**
 * Chrome's extension-id derivation, in the two forms it takes.
 *
 * Shared by `scripts/extension-id.mjs` (prints it) and `scripts/dev.mjs`
 * (trusts it), because a dev server that trusts a *different* id than the one
 * Chrome assigns fails as a flat `403 INVALID_ORIGIN` with nothing on either
 * side saying the two disagreed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Chrome maps each of the first 32 hex digits onto a-p. */
const idFromBytes = (bytes) =>
  [...createHash("sha256").update(bytes).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");

/** The id a manifest `key` (base64 DER public key) pins. */
export const extensionIdFromKey = (key) => idFromBytes(Buffer.from(key, "base64"));

/**
 * A `key` in the built manifest, if the build had EXTENSION_KEY pinned.
 *
 * Read from the built manifest rather than from `manifest.config.ts`, because
 * the key is supplied at build time: the source says only whether it *may* be
 * pinned, the artifact says whether it was.
 */
const pinnedKey = (dir) => {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return typeof manifest.key === "string" && manifest.key !== ""
      ? manifest.key
      : null;
  } catch {
    return null; // half-written or hand-edited: fall back to the path
  }
};

/**
 * The id Chrome gives an unpacked extension loaded from `dir`.
 *
 * A pinned key wins — Chrome hashes the public key's DER bytes and ignores the
 * path. Otherwise the path itself is hashed, which is why every checkout of
 * this repo produces a different id for the same build.
 *
 * The path form needs no build to exist, so this answers before `dist/` does.
 * Chrome hashes the path bytes as-is on POSIX (UTF-16LE on Windows, which this
 * deliberately does not emulate — it would be wrong on the host it ran on).
 */
export function extensionId(dir) {
  const key = pinnedKey(dir);
  return {
    id: key ? extensionIdFromKey(key) : idFromBytes(dir),
    source: key ? "pinned manifest key" : "unpacked load path",
  };
}

/** `chrome-extension://<id>` — the form TRUSTED_ORIGINS and CORS want. */
export function extensionOrigin(dir) {
  return `chrome-extension://${extensionId(dir).id}`;
}
