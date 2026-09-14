#!/usr/bin/env node
// Runs the fixture e-invoices through the reference validators:
//   - Mustang (with veraPDF inside) for every *.en16931.xml and *.zugferd.pdf
//     (Factur-X/ZUGFeRD EN 16931 schema + schematron, PDF/A-3b),
//   - KoSIT with the XRechnung 3.0 configuration for every *.xrechnung.xml.
//
//   JAVA=/opt/homebrew/opt/openjdk@11/bin/java pnpm einvoice:validate
//
// Flags: --java <path>  --cache <dir>  --out <dir>  --only <case>  --skip-generate
//
// Java: --java, else $JAVA, else $JAVA_HOME/bin/java, else Homebrew's
// openjdk@11 when present, else `java` on PATH. Nothing is installed.
//
// It fails closed. A pass needs an explicit verdict from each tool on top of
// its exit code, and every run feeds each verdict (KoSIT, Mustang's XML check,
// Mustang's veraPDF check) a deliberately broken file,
// because a validator that stopped detecting errors looks exactly like one
// that found none. Writes only under --cache and --out; reads no secrets.
//
// Versions and checksums live here and nowhere else; the CI cache key hashes
// this file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MUSTANG = {
  version: "2.26.0",
  sha1: "8755fc333032f802ad7dcf3930201edfe64014e2",
  url: (v) => `https://repo1.maven.org/maven2/org/mustangproject/Mustang-CLI/${v}/Mustang-CLI-${v}.jar`,
};
const KOSIT = {
  version: "1.6.3",
  sha1: "2e9642d10d953ffbde48b8e921eaf042b37d2b17",
  url: (v) => `https://repo1.maven.org/maven2/org/kosit/validator/${v}/validator-${v}-standalone.jar`,
};
const XR_CONFIG = {
  tag: "v2026-08-31",
  file: "xrechnung-3.0.2-validator-configuration-2026-08-31.zip",
  sha256: "2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8",
  url: (t, f) => `https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/${t}/${f}`,
};
/** KoSIT warning codes accepted without failing, each with a reason. Empty in v1: none are expected with 6-dp quantities. */
const WAIVED_KOSIT_WARNINGS = new Map([]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Arguments ──────────────────────────────────────────────────────────────

/** Homebrew's keg-only JDK: never on PATH, and macOS's /usr/bin/java stub fails without a system JDK. */
const HOMEBREW_JAVA = "/opt/homebrew/opt/openjdk@11/bin/java";

function defaultJava() {
  if (process.env.JAVA) return process.env.JAVA;
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, "bin", "java");
  if (existsSync(HOMEBREW_JAVA)) return HOMEBREW_JAVA;
  return "java";
}

function parseArgs(argv) {
  const options = {
    java: defaultJava(),
    cache: join(ROOT, ".cache", "einvoice-validators"),
    out: join(ROOT, ".cache", "einvoice-validation"),
    only: undefined,
    skipGenerate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--") continue;
    else if (arg === "--java") options.java = value();
    else if (arg === "--cache") options.cache = resolve(value());
    else if (arg === "--out") options.out = resolve(value());
    else if (arg === "--only") options.only = value();
    else if (arg === "--skip-generate") options.skipGenerate = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// ── Reporting ──────────────────────────────────────────────────────────────

const results = [];
let failed = false;

function heading(text) {
  console.log(`\n▸ ${text}`);
}

function record(file, validator, pass, detail = "") {
  results.push({ file, validator, verdict: pass ? "pass" : "FAIL", detail });
  if (!pass) failed = true;
  console.log(`  ${pass ? "✓" : "✗"} ${file} (${validator})${detail ? `: ${detail}` : ""}`);
}

function stop(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  return { status: result.status ?? (result.error ? -1 : 0), stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

// ── Steps ──────────────────────────────────────────────────────────────────

function preflightJava(java) {
  heading(`Java (${java})`);
  const result = run(java, ["-version"]);
  const text = `${result.stderr}${result.stdout}`;
  if (result.status !== 0 || result.error) {
    stop(`No working Java. Set JAVA, e.g. JAVA=${HOMEBREW_JAVA} pnpm einvoice:validate`);
  }
  const match = /version "(\d+)(?:\.(\d+))?/.exec(text);
  const major = match ? (match[1] === "1" ? Number(match[2]) : Number(match[1])) : Number.NaN;
  if (!(major >= 11)) stop(`Java 11 or newer is required, found: ${text.split("\n")[0]}`);
  console.log(`  Java ${major}`);
}

function digest(file, algorithm) {
  return createHash(algorithm).update(readFileSync(file)).digest("hex");
}

async function fetchVerified(url, target, algorithm, expected) {
  if (!existsSync(target)) {
    console.log(`  downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) stop(`download failed (${response.status}): ${url}`);
    const part = `${target}.part`;
    writeFileSync(part, Buffer.from(await response.arrayBuffer()));
    renameSync(part, target);
  }
  const actual = digest(target, algorithm);
  if (actual !== expected) {
    rmSync(target, { force: true });
    stop(`${basename(target)}: ${algorithm} ${actual} does not match the pinned ${expected} (file deleted)`);
  }
  console.log(`  ✓ ${basename(target)} (${algorithm} verified)`);
}

async function fetchTools(cache) {
  heading("Validators");
  mkdirSync(cache, { recursive: true });
  const mustang = join(cache, `Mustang-CLI-${MUSTANG.version}.jar`);
  const kosit = join(cache, `validator-${KOSIT.version}-standalone.jar`);
  const zip = join(cache, XR_CONFIG.file);
  const config = join(cache, `xrechnung-${XR_CONFIG.tag}`);
  await fetchVerified(MUSTANG.url(MUSTANG.version), mustang, "sha1", MUSTANG.sha1);
  await fetchVerified(KOSIT.url(KOSIT.version), kosit, "sha1", KOSIT.sha1);
  await fetchVerified(XR_CONFIG.url(XR_CONFIG.tag, XR_CONFIG.file), zip, "sha256", XR_CONFIG.sha256);
  if (!existsSync(join(config, "scenarios.xml"))) {
    mkdirSync(config, { recursive: true });
    const unzip = run("unzip", ["-q", "-o", zip, "-d", config]);
    if (unzip.error) stop("unzip is not installed: install it (apt-get install unzip) and rerun");
    if (unzip.status !== 0) stop(`unzip failed: ${unzip.stderr}`);
  }
  return { mustang, kosit, config };
}

// ── Mustang and KoSIT ──────────────────────────────────────────────────────

const firstMatch = (text, pattern) => pattern.exec(text)?.[1]?.replace(/\s+/g, " ").trim() ?? "";

/**
 * Mustang's verdict on one file. `pass` needs exit 0, a final `valid` summary,
 * no <error>/<warning>, and for a PDF a valid <pdf> section with flavour 3b,
 * isCompliant=true and no failed clause.
 *
 * `--no-notices` hides one expected notice: BR-DE-21 on every *.en16931.xml,
 * because Mustang also runs the XRechnung CIUS rules on German invoices and an
 * EN 16931 (non-XRechnung) guideline id is exactly what that profile carries.
 */
function mustangVerdict(tools, java, file, reports) {
  const result = run(java, [
    "-Xmx1G",
    "-Dfile.encoding=UTF-8",
    "-jar",
    tools.mustang,
    "--action",
    "validate",
    "--source",
    file,
    "--no-notices",
    "--disable-file-logging",
  ]);
  writeFileSync(join(reports, `${basename(file)}.mustang.xml`), result.stdout);
  const summaries = [...result.stdout.matchAll(/<summary status="([^"]*)"\s*\/>/g)].map((m) => m[1]);
  const last = summaries[summaries.length - 1];
  const firstError = firstMatch(result.stdout, /<error[^>]*>([\s\S]*?)<\/error>/);
  const firstWarning = firstMatch(result.stdout, /<warning[^>]*>([\s\S]*?)<\/warning>/);
  const problems = [];
  if (result.status !== 0) problems.push(`exit ${result.status}`);
  if (last !== "valid") problems.push(`summary ${last ?? "missing"}`);
  if (firstError) problems.push(`error: ${firstError.slice(0, 200)}`);
  if (firstWarning) problems.push(`warning: ${firstWarning.slice(0, 200)}`);
  if (file.endsWith(".pdf")) {
    const pdf = /<pdf>([\s\S]*?)<\/pdf>/.exec(result.stdout)?.[1];
    const pdfSummary = pdf === undefined ? undefined : /<summary status="([^"]*)"/.exec(pdf)?.[1];
    // Mustang's overall summary and exit code stay "valid"/0 when veraPDF fails
    // the file (seen with 2.26.0), so the PDF/A verdict is read here directly.
    if (pdfSummary !== "valid") problems.push(`PDF/A section ${pdfSummary ?? "missing"}`);
    const flavour = pdf === undefined ? undefined : /flavour=([0-9a-z]+)/.exec(pdf)?.[1];
    if (pdf !== undefined && flavour !== "3b") problems.push(`PDF/A flavour ${flavour ?? "missing"}, expected 3b`);
    if (pdf !== undefined && !/isCompliant=true/.test(pdf)) problems.push("veraPDF isCompliant is not true");
    const failedClause = pdf === undefined ? undefined : /clause=([^,\]]+), testNumber=(\d+)\], status=failed/.exec(pdf);
    if (failedClause) problems.push(`PDF/A clause ${failedClause[1]}-${failedClause[2]} failed`);
  }
  if (result.error) problems.push(String(result.error));
  return { pass: problems.length === 0, detail: problems.join("; ") };
}

function runMustang(tools, java, files, reports) {
  heading(`Mustang ${MUSTANG.version}: ZUGFeRD / Factur-X EN 16931`);
  if (files.length === 0) record("(no files)", "mustang", false, "nothing to validate");
  for (const file of files) {
    const verdict = mustangVerdict(tools, java, file, reports);
    record(basename(file), "mustang", verdict.pass, verdict.detail);
  }
}

/** KoSIT over many files at once. Returns per-file { pass, detail }. */
function kositVerdicts(tools, java, files, reports) {
  mkdirSync(reports, { recursive: true });
  const result = run(java, [
    "-jar",
    tools.kosit,
    "-s",
    join(tools.config, "scenarios.xml"),
    "-r",
    tools.config,
    "-o",
    reports,
    "-h",
    ...files,
  ]);
  const verdicts = new Map();
  for (const file of files) {
    const report = join(reports, `${basename(file).replace(/\.xml$/, "")}-report.xml`);
    const problems = [];
    if (!existsSync(report)) {
      problems.push("no report written");
    } else {
      const text = readFileSync(report, "utf8");
      if (!text.includes("<rep:accept")) problems.push("not accepted");
      for (const [tag] of text.matchAll(/<rep:message\b[^>]*>/g)) {
        const level = /\slevel="([^"]*)"/.exec(tag)?.[1];
        const code = /\scode="([^"]*)"/.exec(tag)?.[1] ?? "?";
        if (level === "error") problems.push(`error ${code}`);
        if (level === "warning" && !WAIVED_KOSIT_WARNINGS.has(code)) problems.push(`warning ${code}`);
      }
    }
    verdicts.set(file, { pass: problems.length === 0, detail: problems.join("; ") });
  }
  return { status: result.status, stderr: result.stderr, verdicts };
}

function runKosit(tools, java, files, reports) {
  heading(`KoSIT ${KOSIT.version}: XRechnung 3.0 (${XR_CONFIG.tag})`);
  if (files.length === 0) {
    record("(no files)", "kosit", false, "nothing to validate");
    return;
  }
  const { status, stderr, verdicts } = kositVerdicts(tools, java, files, reports);
  for (const file of files) {
    const verdict = verdicts.get(file);
    record(basename(file), "kosit", verdict.pass, verdict.detail);
  }
  // The exit code is the number of rejected files.
  if (status !== 0) record("(all files)", "kosit", false, `exit ${status}${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`);
}

// ── Self-check ─────────────────────────────────────────────────────────────

function selfCheck(tools, java, samples, out) {
  heading("Self-check: every validator must reject a broken file");
  const negative = join(out, "negative");
  mkdirSync(negative, { recursive: true });

  const xr = join(samples, "standard-19.xrechnung.xml");
  const en = join(samples, "standard-19.en16931.xml");
  if (!existsSync(xr) || !existsSync(en)) {
    record("(self-check)", "self-check", false, "standard-19 samples missing (is --only set?)");
    return;
  }

  const noBt23 = join(negative, "no-bt23.xrechnung.xml");
  const withoutBt23 = readFileSync(xr, "utf8").replace(
    /\s*<ram:BusinessProcessSpecifiedDocumentContextParameter>[\s\S]*?<\/ram:BusinessProcessSpecifiedDocumentContextParameter>/,
    "",
  );
  writeFileSync(noBt23, withoutBt23);
  const kosit = kositVerdicts(tools, java, [noBt23], join(negative, "reports"));
  const kositPassed = kosit.status === 0 || kosit.verdicts.get(noBt23)?.pass === true;
  record(basename(noBt23), "kosit must reject", !kositPassed, kositPassed ? "validator self-check passed an invalid file" : "");

  const noTypeCode = join(negative, "no-typecode.en16931.xml");
  writeFileSync(noTypeCode, readFileSync(en, "utf8").replace(/\s*<ram:TypeCode>380<\/ram:TypeCode>/, ""));
  const mustang = run(java, ["-Xmx1G", "-jar", tools.mustang, "--action", "validate", "--source", noTypeCode, "--no-notices", "--disable-file-logging"]);
  const mustangPassed = mustang.status === 0;
  record(basename(noTypeCode), "mustang must reject", !mustangPassed, mustangPassed ? "validator self-check passed an invalid file" : "");

  // The PDF/A verdict needs its own broken file: the XML self-check above
  // never reaches veraPDF. Renaming the catalog's /OutputIntents key (same
  // length, so every xref offset stays right) leaves the DeviceRGB drawing
  // without the output intent PDF/A requires (ISO 19005-3 6.2.4.3).
  // Mustang 2.26.0 still exits 0 and ends on an overall <summary status="valid"/>
  // for such a file; only its <pdf> section says invalid. That section is
  // therefore what both this check and mustangVerdict() read.
  const pdf = join(samples, "standard-19.zugferd.pdf");
  if (!existsSync(pdf)) {
    record("(self-check)", "self-check", false, "standard-19.zugferd.pdf missing");
    return;
  }
  const bytes = readFileSync(pdf);
  const at = bytes.indexOf("/OutputIntents");
  if (at === -1) {
    record("no-output-intent.zugferd.pdf", "veraPDF must reject", false, "standard-19.zugferd.pdf has no /OutputIntents to remove");
    return;
  }
  const broken = Buffer.from(bytes);
  broken.write("/OutputIntentX", at, "latin1");
  const noIntent = join(negative, "no-output-intent.zugferd.pdf");
  writeFileSync(noIntent, broken);
  const vera = run(java, ["-Xmx1G", "-jar", tools.mustang, "--action", "validate", "--source", noIntent, "--no-notices", "--disable-file-logging"]);
  writeFileSync(join(negative, "no-output-intent.zugferd.pdf.mustang.xml"), vera.stdout);
  const pdfSection = /<pdf>([\s\S]*?)<\/pdf>/.exec(vera.stdout)?.[1];
  const pdfStatus = pdfSection === undefined ? undefined : /<summary status="([^"]*)"/.exec(pdfSection)?.[1];
  const rejected = pdfStatus === "invalid" && /isCompliant=false/.test(pdfSection ?? "");
  record(
    basename(noIntent),
    "veraPDF must reject",
    rejected,
    rejected ? "" : `validator self-check passed an invalid file (exit ${vera.status}, PDF/A section ${pdfStatus ?? "missing"})`,
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

function generate(samples, only) {
  heading("Generating samples");
  const args = ["--filter", "@starter/server", "run", "einvoice:samples", "--", "--out", samples];
  if (only !== undefined) args.push("--only", only);
  const result = spawnSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) stop("the sample generator failed: see its output above (a golden mismatch also stops it here)");
}

function summary() {
  heading("Summary");
  const width = Math.max(4, ...results.map((r) => r.file.length));
  const validatorWidth = Math.max(9, ...results.map((r) => r.validator.length));
  console.log(`  ${"file".padEnd(width)}  ${"validator".padEnd(validatorWidth)}  verdict  first problem`);
  for (const r of results) {
    console.log(`  ${r.file.padEnd(width)}  ${r.validator.padEnd(validatorWidth)}  ${r.verdict.padEnd(7)}  ${r.detail.split("; ")[0] ?? ""}`);
  }
  console.log(failed ? "\n✗ e-invoice validation failed" : "\n✓ every e-invoice passed");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  preflightJava(options.java);
  const tools = await fetchTools(options.cache);

  const samples = join(options.out, "samples");
  const reports = join(options.out, "reports");
  if (!options.skipGenerate) {
    rmSync(options.out, { recursive: true, force: true });
    generate(samples, options.only);
  }
  mkdirSync(reports, { recursive: true });
  if (!existsSync(samples)) stop(`no samples in ${samples}: run without --skip-generate`);

  const files = readdirSync(samples).sort().map((name) => join(samples, name));
  const pdfs = files.filter((f) => f.endsWith(".zugferd.pdf"));
  const en = files.filter((f) => f.endsWith(".en16931.xml"));
  const xr = files.filter((f) => f.endsWith(".xrechnung.xml"));

  // Every case renders a ZUGFeRD PDF. A run without one validated nothing about PDF/A.
  if (pdfs.length === 0) stop(`no *.zugferd.pdf in ${samples}: the sample generator must render the PDF/A-3 files`);
  runMustang(tools, options.java, [...pdfs, ...en], reports);
  runKosit(tools, options.java, xr, reports);
  selfCheck(tools, options.java, samples, options.out);
  summary();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => stop(error instanceof Error ? error.stack ?? error.message : String(error)));
