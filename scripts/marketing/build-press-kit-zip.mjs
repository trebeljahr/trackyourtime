#!/usr/bin/env node
/**
 * Builds the press kit a journalist downloads from /press/.
 *
 *   pnpm marketing:press-kit-zip
 *
 * Output: `packages/client/public/press-kit.zip`, containing
 *
 *   marketing/<9 product screenshots>   the same files the public pages serve
 *   brand/<6 SVG marks>                 the source of every shipped bitmap
 *   icon-512.png                        the app icon
 *   og.png                              the 1200x630 social card
 *   fact-sheet.txt                      plain text, from the vault press-kit note
 *
 * **The zip is a build artifact, and it is committed anyway.** Neither
 * `pnpm build:web` nor `packages/client/Dockerfile` runs this script: the web
 * build copies `public/` into `out/` as it finds it, so a zip that only exists
 * on the machine that ran the builder is a 404 on the deployed site. Committing
 * it is what keeps `pnpm build:web` reproducible from a fresh checkout. That
 * only works while the bytes are stable, which is the next paragraph.
 *
 * **Deterministic.** Entries are sorted by their path in the archive, stored
 * rather than deflated, and their DOS timestamp fields are zeroed, so two runs
 * over unchanged inputs produce byte-identical files and a rebuild shows an
 * empty diff. No zip dependency: the local and central headers are written
 * here, which is also why nothing can quietly reintroduce a timestamp.
 *
 * The fact sheet is NOT written here. It comes out of the project's press-kit
 * note in the ricos.site vault, so the kit and the note cannot state different
 * facts. A missing note, or a renamed heading in it, fails the build rather
 * than shipping a kit with no fact sheet.
 */
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The vault note this kit's fact sheet comes from. See the header. */
const SOURCE_PRESS_KIT =
  "/Users/rico/projects/ricos.site/src/content/Notes/texts/misc/claude-chat-gpt-generated/projects/tracktime/trackyourtime-press-kit.md";

const PUBLIC_DIR = path.join(ROOT, "packages", "client", "public");
const OUT_ZIP = path.join(PUBLIC_DIR, "press-kit.zip");

/**
 * Whole directories, copied in under a prefix. Both are served by the live
 * pages at those exact paths, so what a journalist downloads is what the site
 * shows — see docs/marketing/README.md.
 */
const DIRECTORIES = [
  { dir: path.join(PUBLIC_DIR, "marketing"), prefix: "marketing" },
  { dir: path.join(PUBLIC_DIR, "brand"), prefix: "brand" },
];

/** Single files. A missing one is a note on stdout, never a failure. */
const FILES = [
  { source: path.join(ROOT, "build", "icon.png"), zipPath: "icon-512.png", label: "app icon" },
  { source: path.join(PUBLIC_DIR, "og.png"), zipPath: "og.png", label: "social card" },
];

/** A kit a person downloads over a phone connection. Well under this today. */
const MAX_ZIP_BYTES = 64 * 1024 * 1024;

const REGULAR_FILE_MODE = (0o100644 << 16) >>> 0;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const ZERO_DOS_TIME = 0;
const ZERO_DOS_DATE = 0;

async function main() {
  const entries = [];

  for (const { dir, prefix } of DIRECTORIES) {
    const files = await listFiles(dir);
    if (files.length === 0) throw new Error(`no files under ${path.relative(ROOT, dir)}`);
    for (const file of files) {
      const relativePath = path.relative(dir, file).split(path.sep).join("/");
      entries.push({ zipPath: `${prefix}/${relativePath}`, data: await readFile(file) });
    }
  }

  for (const { source, zipPath, label } of FILES) {
    if (!(await isReadableFile(source))) {
      console.log(`skipped ${label}: ${path.relative(ROOT, source)} is not there`);
      continue;
    }
    entries.push({ zipPath, data: await readFile(source) });
  }

  entries.push({ zipPath: "fact-sheet.txt", data: Buffer.from(await buildFactSheetText(), "utf8") });

  await mkdir(path.dirname(OUT_ZIP), { recursive: true });
  await writeFile(OUT_ZIP, buildZip(entries));

  const size = (await stat(OUT_ZIP)).size;
  if (size > MAX_ZIP_BYTES) {
    await unlink(OUT_ZIP);
    throw new Error(`press kit is ${formatBytes(size)}, over the ${formatBytes(MAX_ZIP_BYTES)} cap`);
  }

  console.log(`wrote ${path.relative(ROOT, OUT_ZIP)} (${formatBytes(size)}, ${entries.length} files)`);
}

async function isReadableFile(file) {
  try {
    await access(file, fsConstants.R_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Every file under `dir`, recursively, in a locale-independent order. */
async function listFiles(dir) {
  if (!existsSync(dir)) return [];

  const dirents = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const files = [];

  for (const dirent of dirents) {
    const file = path.join(dir, dirent.name);
    if (dirent.isDirectory()) files.push(...(await listFiles(file)));
    // .DS_Store and friends would change the kit depending on who opened the folder.
    else if (dirent.isFile() && !dirent.name.startsWith(".")) files.push(file);
  }

  return files;
}

/**
 * `fact-sheet.txt`: the note's fact-sheet code block, then its boilerplate with
 * the Markdown taken off. Both headings are named in the note, which says that
 * renaming one breaks this build.
 */
async function buildFactSheetText() {
  const source = await readFile(SOURCE_PRESS_KIT, "utf8");
  const factSheet = extractFirstCodeBlock(section(source, "Fact sheet"));
  const boilerplate = stripMarkdown(section(source, "Boilerplate"));
  const oneLine = stripMarkdown(section(source, "One line"));

  return [
    "TRACK YOUR TIME — PRESS KIT",
    "",
    "https://trackyourtime.dev/press/",
    "",
    "----------------------------------------------------------------------",
    "",
    factSheet,
    "",
    "----------------------------------------------------------------------",
    "",
    "ONE LINE",
    "",
    oneLine,
    "",
    "BOILERPLATE",
    "",
    boilerplate,
    "",
  ].join("\n");
}

/** One `## <heading>` section of the note, up to the next `##`. */
function section(markdown, heading) {
  const match = markdown.match(new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m"));
  if (!match || match.index === undefined) throw new Error(`missing section: ## ${heading}`);

  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function extractFirstCodeBlock(markdown) {
  const match = markdown.match(/```[^\n]*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("missing fact-sheet code block");
  return match[1].replace(/\r\n/g, "\n").trim();
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildZip(rawEntries) {
  const entries = dedupeAndSortEntries(rawEntries);
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.zipPath, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORE_METHOD, 8);
    localHeader.writeUInt16LE(ZERO_DOS_TIME, 10);
    localHeader.writeUInt16LE(ZERO_DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    chunks.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(STORE_METHOD, 10);
    centralHeader.writeUInt16LE(ZERO_DOS_TIME, 12);
    centralHeader.writeUInt16LE(ZERO_DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(REGULAR_FILE_MODE, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(...centralDirectory);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  return Buffer.concat(chunks);
}

/**
 * Sorted by archive path with a plain code-unit comparison, so the order does
 * not follow the machine's locale, and refusing anything that could escape the
 * folder a reader unzips into.
 */
function dedupeAndSortEntries(entries) {
  const byPath = new Map();

  for (const entry of entries) {
    const { zipPath } = entry;
    if (path.isAbsolute(zipPath) || zipPath.includes("..") || zipPath.includes("\\")) {
      throw new Error(`unsafe zip path: ${zipPath}`);
    }
    if (byPath.has(zipPath)) throw new Error(`duplicate zip path: ${zipPath}`);
    byPath.set(zipPath, entry);
  }

  return [...byPath.values()].sort((a, b) =>
    a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0,
  );
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let value = i;
  for (let j = 0; j < 8; j++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
