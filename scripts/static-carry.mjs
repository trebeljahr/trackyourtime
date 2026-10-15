#!/usr/bin/env node
/**
 * Carry the hashed assets of earlier releases into this upload of the web app.
 *
 *   node scripts/static-carry.mjs --out <out-dir> --sha <sha> --from <https://live-site>
 *   node scripts/static-carry.mjs --out <out-dir> --sha <sha> --seed-dir <old-out> --seed-sha <sha>
 *
 * `--from` reads `/release-assets.json` from the live site and downloads the
 * files it lists. A site that has none (404) is a first upload and carries
 * nothing, with a warning; any other failure to read it fails the build,
 * because an upload without the previous chunks breaks every open tab.
 * `--seed-dir` takes the previous release from an export on disk — the
 * Coolify client image's out/, for the first upload to the Worker.
 *
 * Logic and tests: scripts/lib/static-carry.mjs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { carry, KEEP, MANIFEST_FILE, MAX_CARRY_BYTES, manifestFromDir, parseManifest } from "./lib/static-carry.mjs";

const inActions = process.env.GITHUB_ACTIONS === "true";
const warn = (message) => console.log(inActions ? `::warning::${message}` : `WARNING: ${message}`);

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    sha: { type: "string" },
    from: { type: "string" },
    "seed-dir": { type: "string" },
    "seed-sha": { type: "string" },
    keep: { type: "string", default: String(KEEP) },
    "max-bytes": { type: "string", default: String(MAX_CARRY_BYTES) },
  },
});

const main = async () => {
  if (!values.out || !values.sha || (!values.from) === !values["seed-dir"]) {
    console.error("usage: node scripts/static-carry.mjs --out <dir> --sha <sha> (--from <url> | --seed-dir <dir> --seed-sha <sha>)");
    return 2;
  }

  let previous = null;
  let read;
  if (values["seed-dir"]) {
    const seed = values["seed-dir"];
    previous = manifestFromDir(seed, values["seed-sha"]);
    read = async (path) => readFileSync(join(seed, ...path.slice(1).split("/")));
  } else {
    const base = values.from.replace(/\/+$/, "");
    const response = await fetch(`${base}/${MANIFEST_FILE}?cb=${Date.now()}`, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) {
      warn(`${base} serves no ${MANIFEST_FILE}, so nothing is carried: tabs opened before this deploy lose their lazy chunks.`);
    } else if (!response.ok) {
      throw new Error(`${base}/${MANIFEST_FILE} answered ${response.status}`);
    } else {
      previous = parseManifest(await response.text());
    }
    read = async (path) => {
      for (let attempt = 1; ; attempt += 1) {
        const file = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
        if (file.ok) return Buffer.from(await file.arrayBuffer());
        if (attempt === 3) throw new Error(`${base}${path} answered ${file.status}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    };
  }

  const result = await carry({
    outDir: values.out,
    sha: values.sha.trim().toLowerCase(),
    previous,
    read,
    keep: Number(values.keep),
    maxBytes: Number(values["max-bytes"]),
    log: (line) => console.log(line),
  });
  console.log(`${join(values.out, MANIFEST_FILE)}: this release plus ${result.carried.length} carried`);
  return 0;
};

main().then(
  (code) => process.exit(code),
  (caught) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(inActions ? `::error::${message}` : `ERROR: ${message}`);
    process.exit(1);
  },
);
