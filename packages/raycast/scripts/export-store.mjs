#!/usr/bin/env node
/**
 * Writes an npm-ready copy of the Raycast extension, the directory the Raycast
 * Store's `publish` command is run from.
 *
 * The store builds `extensions/<name>` in raycast/extensions with `npm ci` and
 * `ray build`, so the copy must stand alone: no `workspace:` dependency, a
 * `package-lock.json` from npm (never pnpm), the Raycast template's scripts,
 * and no build output (`publish` copies `dist/` if it is there).
 *
 * It never publishes. Publishing is `npm run publish` inside the exported
 * directory, run by a person — see the procedure printed at the end.
 *
 * Usage:
 *   node scripts/export-store.mjs [outDir] [options]
 *
 *   outDir               default: packages/raycast/store (gitignored)
 *   --author <handle>    Raycast username to write into the copy's package.json (required)
 *   --license <id>       license to write into the copy's package.json (required; the store takes MIT)
 *   --draft              allow a copy without --author/--license, which `publish` rejects
 *   --lint               run `ray lint` in the copy (not with --draft)
 *   --build              run `ray build -e dist` in the copy, into a temp dir
 *   --no-install         skip `npm install` (no package-lock.json is written)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { RAYCAST_DIR, REPO_DIR, VENDOR_DIR, vendorDrift } from "./vendor-core.mjs";

const DEFAULT_OUT = path.join(RAYCAST_DIR, "store");

/** Files and folders the store copy is made of. Missing optional ones are skipped. */
const COPY = [
  { name: "src", required: true },
  { name: "assets", required: true },
  { name: "metadata" },
  { name: "media" },
  { name: "README.md", required: true },
  { name: "CHANGELOG.md", required: true },
  { name: "tsconfig.json", required: true },
  { name: "raycast-env.d.ts" },
  { name: "eslint.config.js", required: true },
  { name: ".prettierrc", required: true },
  { name: ".prettierignore" },
];

/**
 * The copy's .gitignore: the monorepo package's without the line that ignores
 * this script's own output directory, which means nothing in the store.
 */
export const STORE_GITIGNORE = `dist
node_modules
.raycast-swift-build
.swiftpm
compiled_raycast_swift
`;

/**
 * Text in the copied README that only makes sense inside the monorepo. The
 * store page renders the README, so maintainer steps live in PUBLISHING.md,
 * which is not copied.
 */
export const MONOREPO_ONLY_README = [/\bpnpm\b/, /packages\//, /src\/vendor/, /^#+ Publishing\b/m];

export function monorepoLeftovers(readme) {
  return MONOREPO_ONLY_README.filter((pattern) => pattern.test(readme)).map(String);
}

/**
 * Text a store user could see in the extension's own strings (not comments,
 * not src/vendor) that only makes sense inside the monorepo.
 */
export const MONOREPO_ONLY_UI = [/\bpnpm\b/, /\bworktree/i, /packages\//, /src\/vendor/];

/** Every string literal and JSX text in a TS/TSX source, comments excluded. */
export function visibleStrings(fileName, text) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `file: "string"` for every visible string in src (minus src/vendor) matching MONOREPO_ONLY_UI. */
export function sourceLeftovers(srcDir = path.join(RAYCAST_DIR, "src")) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== VENDOR_DIR && entry.name !== "vendor") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        for (const str of visibleStrings(full, fs.readFileSync(full, "utf8"))) {
          if (MONOREPO_ONLY_UI.some((pattern) => pattern.test(str))) {
            found.push(`${path.relative(srcDir, full)}: ${JSON.stringify(str)}`);
          }
        }
      }
    }
  };
  walk(srcDir);
  return found;
}

/** The line in src/lib/local-defaults.ts the store copy flips. */
export const LOCAL_DEFAULTS_LINE = "export const DEV_BUILD_USES_LOCALHOST: boolean = true;";

/**
 * src/lib/local-defaults.ts for the store copy: a `ray develop` build there
 * (a Store reviewer's `npm run dev`) defaults to the hosted service.
 */
export function storeLocalDefaults(text) {
  const count = text.split(LOCAL_DEFAULTS_LINE).length - 1;
  if (count !== 1) throw new Error(`src/lib/local-defaults.ts must contain "${LOCAL_DEFAULTS_LINE}" exactly once`);
  return text.replace(LOCAL_DEFAULTS_LINE, LOCAL_DEFAULTS_LINE.replace("= true;", "= false;"));
}

/**
 * A vendored file for the store copy: the monorepo's GENERATED header (which
 * names a script and a command the copy does not have) becomes a note on
 * where the file comes from. Everything below the header is unchanged.
 */
export function storeVendorHeader(text) {
  const file = text.match(
    /^\/\/ GENERATED by packages\/raycast\/scripts\/vendor-core\.mjs from (\S+)\.\n\/\/ Do not edit\.[^\n]*\n/,
  );
  if (file) {
    return (
      `// Copied from ${file[1]} in the Track Your Time repository, where this code is\n` +
      `// developed and tested. Changes belong there; this copy is regenerated from it.\n` +
      text.slice(file[0].length)
    );
  }
  const index = text.match(
    /^\/\/ GENERATED by packages\/raycast\/scripts\/vendor-core\.mjs\. Do not edit\.\n(\/\/[^\n]*\n)*/,
  );
  if (index) {
    return (
      `// The names this extension imports from the Track Your Time core library, copied\n` +
      `// from the Track Your Time repository. Changes belong there; this copy is regenerated.\n` +
      text.slice(index[0].length)
    );
  }
  throw new Error("vendored file has no GENERATED header");
}

/** Files in an export that still name the monorepo's vendoring tooling. */
export function copyLeftovers(outDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (KEEP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|js|json|md)$|^\.prettier/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (/vendor-core\.mjs|vendor:raycast/.test(text)) found.push(path.relative(outDir, full));
      }
    }
  };
  walk(outDir);
  return found;
}

/** .prettierignore for the store copy. */
export const STORE_PRETTIERIGNORE = `# Copied from the Track Your Time repository, which formats it with its own settings.
src/vendor
`;

/** Kept across re-exports: the copy's own git history, and the install. */
const KEEP = new Set([".git", "node_modules", "package-lock.json"]);

/** The Raycast extension template's scripts, verbatim. */
export const STORE_SCRIPTS = {
  build: "ray build",
  dev: "ray develop",
  "fix-lint": "ray lint --fix",
  lint: "ray lint",
  prepublishOnly:
    'echo "\\n\\nIt seems like you are trying to publish the Raycast extension to npm.\\n\\nIf you did intend to publish it to npm, remove the \\`prepublishOnly\\` script and rerun \\`npm publish\\` again.\\nIf you wanted to publish it to the Raycast Store instead, use \\`npm run publish\\` instead.\\n\\n" && exit 1',
  publish: "npx @raycast/api@latest publish",
};

/** Hosts `ray publish` accepts in package-lock.json `resolved` URLs. */
const ALLOWED_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "npm.jsr.io", "cdn.sheetjs.com"]);

/**
 * `importers["packages/raycast"]` of pnpm-lock.yaml as
 * `{ name: { specifier, version } }`. A line-based read of the one block this
 * needs, so the script carries no YAML dependency.
 */
export function readLockImporter(lockText, importer = "packages/raycast") {
  const lines = lockText.split("\n");
  const start = lines.indexOf(`  ${importer}:`);
  if (start === -1) throw new Error(`pnpm-lock.yaml has no importer "${importer}"`);
  const result = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (!line.startsWith("    ")) break;
    const dep = line.match(/^ {6}('?)([^':]+)\1:\s*$/);
    if (dep) {
      current = dep[2];
      result[current] = {};
      continue;
    }
    const field = line.match(/^ {8}(specifier|version):\s*(.+)$/);
    if (field && current) result[current][field[1]] = field[2].trim();
  }
  return result;
}

/**
 * The version range the store copy declares for one dependency. An exact pin
 * stays as package.json has it; a range takes the version the monorepo
 * lockfile resolved, so `npm install` starts from what was developed against.
 * A lock entry whose specifier differs from package.json (a workspace-level
 * pnpm override) is not this package's choice and is ignored.
 */
export function storeRange(name, spec, lockEntry) {
  if (spec.startsWith("workspace:") || spec.startsWith("link:") || spec.startsWith("file:")) {
    throw new Error(`"${name}": "${spec}" cannot be installed from npm. Vendor it instead (scripts/vendor-core.mjs).`);
  }
  const match = spec.match(/^([~^]?)(\d+\.\d+\.\d+[^\s]*)$/);
  if (!match) return spec;
  const [, operator] = match;
  if (!operator || !lockEntry?.version || lockEntry.specifier !== spec) return spec;
  const resolved = lockEntry.version.replace(/\(.*$/, "");
  return `${operator}${resolved}`;
}

/** package.json for the store copy. Pure, so it is unit-tested. */
export function storePackageJson(pkg, lockImporter, overrides = {}) {
  const out = { ...pkg };
  delete out.private;
  const mapDeps = (deps) =>
    deps
      ? Object.fromEntries(
          Object.entries(deps)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, spec]) => [name, storeRange(name, spec, lockImporter[name])]),
        )
      : undefined;
  out.dependencies = mapDeps(pkg.dependencies) ?? {};
  if (pkg.devDependencies) out.devDependencies = mapDeps(pkg.devDependencies);
  out.scripts = { ...STORE_SCRIPTS };
  if (overrides.author) out.author = overrides.author;
  if (overrides.license) out.license = overrides.license;
  return out;
}

function parseArgs(argv) {
  const opts = {
    outDir: DEFAULT_OUT,
    lint: false,
    build: false,
    install: true,
    draft: false,
    author: null,
    license: null,
  };
  const rest = [...argv];
  let positional = false;
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--lint") opts.lint = true;
    else if (arg === "--build") opts.build = true;
    else if (arg === "--no-install") opts.install = false;
    else if (arg === "--draft") opts.draft = true;
    else if (arg === "--author") opts.author = rest.shift();
    else if (arg === "--license") opts.license = rest.shift();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (!positional) {
      opts.outDir = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);
      positional = true;
    } else throw new Error(`Unexpected argument ${arg}`);
  }
  if (opts.author === undefined || opts.license === undefined) throw new Error("--author and --license take a value");
  if (!opts.help && !opts.draft && (!opts.author || !opts.license)) {
    throw new Error(
      "Pass --author <raycast-username> and --license MIT: the store rejects the monorepo's values. " +
        "--draft writes a copy without them, which publish and ray lint reject.",
    );
  }
  if (opts.draft && opts.lint) throw new Error("--lint cannot pass on a --draft copy; pass --author and --license.");
  return opts;
}

function assertSafeOutDir(outDir, extensionName) {
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(outDir, REPO_DIR) || inside(path.join(RAYCAST_DIR, "src"), outDir) || outDir === RAYCAST_DIR) {
    throw new Error(`Refusing to export into ${outDir}`);
  }
  if (inside(REPO_DIR, outDir) && !inside(DEFAULT_OUT, outDir)) {
    throw new Error(`Inside the monorepo, export only to ${path.relative(REPO_DIR, DEFAULT_OUT)} (it is gitignored).`);
  }
  if (!fs.existsSync(outDir)) return;
  const entries = fs.readdirSync(outDir).filter((e) => e !== ".DS_Store");
  if (entries.length === 0) return;
  const pkgPath = path.join(outDir, "package.json");
  const existing = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) : null;
  if (existing?.name !== extensionName) {
    throw new Error(
      `${outDir} is not empty and is not an earlier export of ${extensionName}; refusing to overwrite it.`,
    );
  }
}

/** The environment for npm and ray: nothing pnpm injected into this process. */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|PNPM_)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function run(cmd, args, cwd) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}   (in ${cwd})`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: cleanEnv() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
}

function checkLockfile(outDir) {
  const lockPath = path.join(outDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (!(lock.lockfileVersion >= 2)) throw new Error(`package-lock.json has lockfileVersion ${lock.lockfileVersion}`);
  const bad = new Set();
  for (const entry of Object.values(lock.packages ?? {})) {
    if (!entry.resolved) continue;
    const host = new URL(entry.resolved).host;
    if (!ALLOWED_REGISTRY_HOSTS.has(host)) bad.add(host);
  }
  if (bad.size) {
    throw new Error(
      `package-lock.json resolves packages from ${[...bad].join(", ")}; the store accepts only ` +
        `${[...ALLOWED_REGISTRY_HOSTS].join(", ")}. Check your npm registry config.`,
    );
  }
}

export function exportStore(opts) {
  const problems = vendorDrift();
  if (problems.length) {
    throw new Error(`src/vendor is stale. Run \`pnpm vendor:raycast\` first:\n  ${problems.join("\n  ")}`);
  }
  const leftovers = monorepoLeftovers(fs.readFileSync(path.join(RAYCAST_DIR, "README.md"), "utf8"));
  if (leftovers.length) {
    throw new Error(
      `README.md is shown on the store page but matches ${leftovers.join(", ")}. Move it to PUBLISHING.md.`,
    );
  }
  const uiLeftovers = sourceLeftovers();
  if (uiLeftovers.length) {
    throw new Error(`Store users would see monorepo-only text in these strings:\n  ${uiLeftovers.join("\n  ")}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(RAYCAST_DIR, "package.json"), "utf8"));
  const lockImporter = readLockImporter(fs.readFileSync(path.join(REPO_DIR, "pnpm-lock.yaml"), "utf8"));
  const storePkg = storePackageJson(pkg, lockImporter, { author: opts.author, license: opts.license });

  const outDir = opts.outDir;
  assertSafeOutDir(outDir, pkg.name);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(outDir)) {
    if (!KEEP.has(entry)) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
  for (const { name, required } of COPY) {
    const from = path.join(RAYCAST_DIR, name);
    if (!fs.existsSync(from)) {
      if (required) throw new Error(`packages/raycast/${name} is missing`);
      continue;
    }
    fs.cpSync(from, path.join(outDir, name), { recursive: true, filter: (src) => path.basename(src) !== ".DS_Store" });
  }
  fs.writeFileSync(path.join(outDir, ".gitignore"), STORE_GITIGNORE);
  fs.writeFileSync(path.join(outDir, ".prettierignore"), STORE_PRETTIERIGNORE);
  const localDefaults = path.join(outDir, "src/lib/local-defaults.ts");
  fs.writeFileSync(localDefaults, storeLocalDefaults(fs.readFileSync(localDefaults, "utf8")));
  const vendorOut = path.join(outDir, "src/vendor");
  const walkVendor = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkVendor(full);
      else fs.writeFileSync(full, storeVendorHeader(fs.readFileSync(full, "utf8")));
    }
  };
  walkVendor(vendorOut);
  const eslintConfig = path.join(outDir, "eslint.config.js");
  fs.writeFileSync(
    eslintConfig,
    fs
      .readFileSync(eslintConfig, "utf8")
      .replace(
        /^ *\/\/ Generated by scripts\/vendor-core\.mjs[^\n]*\n( *\/\/[^\n]*\n)*/m,
        "  // Copied from the Track Your Time repository, which lints it with its own settings.\n",
      ),
  );
  fs.writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(storePkg, null, 2)}\n`);
  const stale = copyLeftovers(outDir);
  if (stale.length) throw new Error(`The store copy still names monorepo tooling:\n  ${stale.join("\n  ")}`);
  console.log(`Exported ${pkg.name} to ${outDir}`);

  if (opts.install) {
    run("npm", ["install", "--no-audit", "--no-fund"], outDir);
    checkLockfile(outDir);
  }
  for (const stray of ["pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "shrinkwrap.json"]) {
    if (fs.existsSync(path.join(outDir, stray))) throw new Error(`${stray} must not be in the store copy`);
  }
  const ray = path.join(outDir, "node_modules/.bin/ray");
  if (opts.lint) run(ray, ["lint"], outDir);
  if (opts.build) {
    const buildOut = fs.mkdtempSync(path.join(os.tmpdir(), "trackyourtime-raycast-build-"));
    try {
      run(ray, ["build", "-e", "dist", "-o", buildOut], outDir);
    } finally {
      fs.rmSync(buildOut, { recursive: true, force: true });
    }
  }
  // `publish` copies everything but .git/node_modules, so build output must not linger.
  fs.rmSync(path.join(outDir, "dist"), { recursive: true, force: true });

  const warnings = [];
  if (storePkg.license !== "MIT")
    warnings.push(`license is "${storePkg.license}"; the store requires "MIT" (--license MIT).`);
  if (storePkg.author !== opts.author) {
    warnings.push(`author is "${storePkg.author}"; it must be a Raycast username (--author <handle>).`);
  }
  for (const w of warnings) console.warn(`warning: ${w}`);

  console.log(`
Next steps (run by hand; this script never publishes):
  cd ${outDir}
  git init && git add -A && git commit -m "Export ${pkg.name}"   # first export only; later: git add -A && git commit
  npm run lint
  npm run build        # note: replaces Raycast's installed dev copy of ${pkg.name}
  npm run publish      # GitHub login, then a draft PR to raycast/extensions
`);
  return { outDir, packageJson: storePkg };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
      console.log(text.slice(text.indexOf("Usage:"), text.indexOf("*/")).replace(/^ \* ?/gm, ""));
    } else {
      exportStore(opts);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
