#!/usr/bin/env node
/**
 * Writes the docs site's self-hosting page from `docs/self-hosting.md`.
 *
 *   pnpm docs:sync
 *
 * `docs/self-hosting.md` stays the canonical guide: the README and the
 * marketing pages link to it on GitHub. The docs site needs the same text with
 * three changes, and a hand-kept copy would drift the first time the guide is
 * edited:
 *
 *   1. Front matter, for the page title, sidebar label and meta description.
 *   2. Repo-relative links (`./deploy.md`, `../.github/...`) rewritten to
 *      absolute GitHub URLs. On the docs site they would resolve to pages that
 *      do not exist, and `onBrokenLinks: "throw"` fails the build. In-page
 *      anchors (`#backup-and-restore`) stay as they are.
 *   3. MDX escaping. Docusaurus compiles `.md` as MDX, where a bare `{` starts
 *      an expression and a bare `<` starts a JSX tag. Code blocks and inline
 *      code are left alone.
 *
 * `scripts/lib/self-hosting-doc.test.mjs` fails when the committed page no
 * longer matches what this script writes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SOURCE_PATH = "docs/self-hosting.md";
export const TARGET_PATH = "docs-site/docs/self-hosting.md";
export const BLOB_URL = "https://github.com/trebeljahr/tracktime/blob/main";

const FRONT_MATTER = [
  "---",
  "title: Self-hosting Track Your Time",
  "sidebar_label: Self-hosting",
  "description: Install Track Your Time on your own Ubuntu server with Docker Compose, check the install with one script, and back it up, upgrade it and fix it.",
  "---",
];

const GENERATED_NOTE =
  "<!-- Generated from docs/self-hosting.md by scripts/docs/sync-self-hosting.mjs. Do not edit by hand: edit the source, then run `pnpm docs:sync`. -->";

const FENCE = /^\s*(`{3,}|~{3,})/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where a link in the source should point on the docs site.
 *
 * @param {string} target the raw link target, e.g. `./deploy.md#coolify`
 * @param {string} sourcePath the source file's repo-relative path
 * @returns {string}
 */
export function rewriteTarget(target, sourcePath = SOURCE_PATH) {
  if (target.startsWith("#") || SCHEME.test(target)) return target;

  const hashAt = target.indexOf("#");
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : target.slice(hashAt);

  const repoPath = path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.normalize(posix.join(posix.dirname(sourcePath), path));
  if (repoPath === ".." || repoPath.startsWith("../")) {
    throw new Error(`Link target leaves the repository: ${target} (in ${sourcePath})`);
  }
  return `${BLOB_URL}/${repoPath}${hash}`;
}

/**
 * Rewrite links and escape MDX in one stretch of prose that holds no code.
 *
 * @param {string} text
 * @param {string} sourcePath
 * @returns {string}
 */
function transformProse(text, sourcePath) {
  // An autolink would be read as a JSX tag once `<` is escaped, so turn it
  // into an ordinary link first.
  const linked = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, "[$1]($1)");

  const parts = [];
  let last = 0;
  const link = /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;
  for (let match = link.exec(linked); match; match = link.exec(linked)) {
    parts.push(escapeMdx(linked.slice(last, match.index)));
    parts.push(`](${rewriteTarget(match[1], sourcePath)}${match[2]})`);
    last = match.index + match[0].length;
  }
  parts.push(escapeMdx(linked.slice(last)));
  return parts.join("");
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeMdx(text) {
  return text.replace(/[{}<]/g, (char) => (char === "<" ? "&lt;" : `\\${char}`));
}

/**
 * Transform one line outside a fenced block, leaving inline code untouched.
 *
 * @param {string} line
 * @param {string} sourcePath
 * @returns {string}
 */
function transformLine(line, sourcePath) {
  let out = "";
  let prose = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      prose += line[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (line[i + run] === "`") run += 1;
    const ticks = "`".repeat(run);
    const close = line.indexOf(ticks, i + run);
    if (close === -1) {
      // An unmatched backtick run is literal text, as in CommonMark.
      prose += ticks;
      i += run;
      continue;
    }
    // Link text can hold inline code, as in [`deploy.md`](./deploy.md). The
    // `](target)` half always lands in the prose after the span, which is
    // the only half the link rewrite reads.
    out += transformProse(prose, sourcePath);
    prose = "";
    out += line.slice(i, close + run);
    i = close + run;
  }
  return out + transformProse(prose, sourcePath);
}

/**
 * The docs-site page for a given source text. Pure: no file access.
 *
 * @param {string} source the contents of `docs/self-hosting.md`
 * @param {{ sourcePath?: string }} [options]
 * @returns {string}
 */
export function renderSelfHostingDoc(source, { sourcePath = SOURCE_PATH } = {}) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  /** @type {string | null} */
  let fence = null;
  const body = lines.map((line) => {
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      return line;
    }
    if (opener) {
      fence = opener[1];
      return line;
    }
    return transformLine(line, sourcePath);
  });

  const text = body.join("\n").replace(/\n*$/, "\n");
  return `${FRONT_MATTER.join("\n")}\n\n${GENERATED_NOTE}\n\n${text}`;
}

/**
 * @returns {string}
 */
export function renderFromRepo() {
  return renderSelfHostingDoc(readFileSync(resolve(REPO_ROOT, SOURCE_PATH), "utf8"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(resolve(REPO_ROOT, TARGET_PATH), renderFromRepo());
  console.log(`Wrote ${TARGET_PATH} from ${SOURCE_PATH}`);
}
