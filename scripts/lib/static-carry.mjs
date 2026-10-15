/**
 * Carry the hashed browser assets of earlier releases into the next upload of
 * the web app's Cloudflare Worker.
 *
 * A Worker version serves only the files uploaded with it. A tab opened before
 * a deploy still holds HTML that names the previous build's chunks, and loads
 * them lazily — on the next route, the next dialog, the invoice generator's
 * PDF code. Without a copy in the new version each of those is a 404 and a
 * broken screen (lib/chunk-reload.ts can only reload, once). So every upload
 * carries the files of the last KEEP releases.
 *
 * What a release is, is published with it: `/release-assets.json` lists the
 * release's own hashed files (path, sha256, size) and the releases it carried.
 * The next build reads that from the live site, downloads what it does not
 * already have — free static-asset requests — checks each against its
 * sha256, and writes the new manifest. The first upload after the Coolify
 * client is seeded from that image's out/ instead (`seedFromDir`).
 *
 * Fails, rather than shipping a guess, when one path would hold two different
 * contents (hashed names must never collide), a download does not match its
 * manifest, or the carry grows past its size limit. Pattern from tiao's
 * client/scripts/carry-release-static.mjs; docs/deploy.md → Web app on
 * Cloudflare.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** The trees whose names carry a content hash, so files of several releases can sit side by side. */
export const CARRY_ROOTS = Object.freeze(["_next/static", "docs/assets"]);

/** Where each upload describes itself, at the site root. */
export const MANIFEST_FILE = "release-assets.json";

/** Earlier releases carried by each upload: the one live at build time, and the one it replaced. */
export const KEEP = 2;

/** Upper bound on carried bytes. A release is ~6 MB today; this catches a carry gone wrong, not growth. */
export const MAX_CARRY_BYTES = 100 * 1024 * 1024;

const SHA = /^[0-9a-f]{7,40}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The hashed files of one exported tree, as `/`-rooted URL paths.
 *
 * @param {string} outDir
 * @returns {{ path: string, sha256: string, size: number }[]}
 */
export const releaseFiles = (outDir) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing a symlink among the release assets: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        found.push({ path: `/${relative(outDir, path).split(sep).join("/")}`, sha256: sha256(bytes), size: bytes.length });
      }
    }
  };
  for (const root of CARRY_ROOTS) {
    if (existsSync(join(outDir, root))) walk(join(outDir, root));
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** Next's build id: the directory under `_next/static` that holds `_buildManifest.js`. */
export const buildIdOf = (outDir) => {
  const root = join(outDir, "_next", "static");
  if (!existsSync(root)) return null;
  const ids = readdirSync(root).filter((name) => existsSync(join(root, name, "_buildManifest.js")));
  return ids.length === 1 ? ids[0] : null;
};

/**
 * A manifest read back from a live site, checked. Throws on a shape this
 * script did not write, because carrying a misread list means shipping a
 * release whose old chunks are silently missing.
 */
export const parseManifest = (text) => {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.releases)) throw new Error(`${MANIFEST_FILE} is not schema 1`);
  for (const release of parsed.releases) {
    if (!SHA.test(release?.sha ?? "")) throw new Error(`${MANIFEST_FILE} lists a release without a commit sha`);
    if (!Array.isArray(release.files)) throw new Error(`${MANIFEST_FILE} release ${release.sha} has no file list`);
    for (const file of release.files) {
      if (typeof file?.path !== "string" || !CARRY_ROOTS.some((root) => file.path.startsWith(`/${root}/`)) || file.path.includes("..")) {
        throw new Error(`${MANIFEST_FILE} release ${release.sha} lists ${String(file?.path)}, outside ${CARRY_ROOTS.join(" and ")}`);
      }
      if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? "") || !Number.isInteger(file.size)) {
        throw new Error(`${MANIFEST_FILE} release ${release.sha} lists ${file.path} without a sha256 and size`);
      }
    }
  }
  return parsed;
};

/**
 * The previous release as a manifest, from an export on disk — the first
 * upload's seed, taken from the Coolify client image that served before it.
 */
export const manifestFromDir = (dir, sha) => {
  if (!SHA.test(sha ?? "")) throw new Error("the seed needs the commit sha its export was built from");
  const files = releaseFiles(dir);
  if (files.length === 0) throw new Error(`${dir} holds none of ${CARRY_ROOTS.join(", ")}`);
  return { schema: 1, releases: [{ sha, buildId: buildIdOf(dir), files }] };
};

/**
 * Add the files of up to `keep` earlier releases to `outDir`, then write
 * `outDir/release-assets.json` naming this release first.
 *
 * @param {object} input
 * @param {string} input.outDir      this build's export
 * @param {string} input.sha         this build's commit
 * @param {object | null} input.previous   the live manifest, or null on a first upload
 * @param {(path: string) => Promise<Buffer>} input.read   bytes of one previous file, by URL path
 * @param {number} [input.keep]
 * @param {number} [input.maxBytes]
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{ manifest: object, carried: { sha: string, buildId: string | null, files: number }[], written: number, bytes: number }>}
 */
export const carry = async ({ outDir, sha, previous, read, keep = KEEP, maxBytes = MAX_CARRY_BYTES, log = () => {} }) => {
  if (!SHA.test(sha ?? "")) throw new Error(`${String(sha)} is not a commit sha`);
  const ownFiles = releaseFiles(outDir);
  const own = { sha, buildId: buildIdOf(outDir), files: ownFiles };
  // Path → sha256 of what will be served there. This build's own files win
  // every path; a carried file may only add a path or agree with it.
  const served = new Map(ownFiles.map((file) => [file.path, { sha256: file.sha256, from: "this build" }]));

  const candidates = (previous?.releases ?? []).filter(
    // The same build uploaded again (a re-run) is this release, not an earlier one.
    (release) => !(own.buildId !== null && release.buildId === own.buildId),
  );
  const selected = [];
  for (const release of candidates) {
    if (selected.length >= keep) break;
    if (selected.some((kept) => kept.sha === release.sha && kept.buildId === release.buildId)) continue;
    selected.push(release);
  }

  const toWrite = [];
  let bytes = 0;
  for (const release of selected) {
    const label = `release ${release.sha.slice(0, 12)}${release.buildId ? ` (${release.buildId})` : ""}`;
    for (const file of release.files) {
      const existing = served.get(file.path);
      if (existing) {
        if (existing.sha256 !== file.sha256) {
          throw new Error(`asset collision at ${file.path}: ${existing.from} and ${label} hold different contents`);
        }
        continue;
      }
      served.set(file.path, { sha256: file.sha256, from: label });
      toWrite.push(file);
      bytes += file.size;
    }
  }
  if (bytes > maxBytes) throw new Error(`the carried assets come to ${bytes} bytes, above the ${maxBytes}-byte limit`);

  // A few downloads at a time: they are free asset requests, but a burst of
  // hundreds at once is not something to do to a site serving people.
  let next = 0;
  const worker = async () => {
    while (next < toWrite.length) {
      const file = toWrite[next];
      next += 1;
      const content = await read(file.path);
      const actual = sha256(content);
      if (actual !== file.sha256 || content.length !== file.size) {
        throw new Error(`${file.path} came back as ${content.length} bytes with sha256 ${actual}, not the ${file.size} bytes and ${file.sha256} its manifest lists`);
      }
      const target = join(outDir, ...file.path.slice(1).split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toWrite.length) }, worker));

  const carried = selected.map((release) => ({ sha: release.sha, buildId: release.buildId ?? null, files: release.files.length }));
  for (const release of carried) log(`carried release ${release.sha} (${release.files} files)`);
  log(`${toWrite.length} files written, ${bytes} bytes`);

  const manifest = { schema: 1, releases: [own, ...selected.map(({ sha: s, buildId, files }) => ({ sha: s, buildId: buildId ?? null, files }))] };
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
  return { manifest, carried, written: toWrite.length, bytes };
};
