/*
 * Pure helpers shared by the host runner (../linux-package-smoke.mjs) and the
 * in-container installer (./install.mjs). No I/O, no child processes, so both
 * ends agree about what a package is and where its executable lives, and the
 * rules can be unit-tested without Docker.
 *
 * Project-agnostic, like the rest of scripts/crossplat: nothing here names an
 * app or reaches into the repository around it.
 */

/** The three packaged Linux artifacts this can test, by file extension. */
export const PACKAGE_KINDS = ["appimage", "deb", "rpm"];

/** Which kind `file` is, or null when the extension is not one of ours. */
export function packageKind(file) {
  const name = String(file ?? "").toLowerCase();
  if (name.endsWith(".appimage")) return "appimage";
  if (name.endsWith(".deb")) return "deb";
  if (name.endsWith(".rpm")) return "rpm";
  return null;
}

/**
 * One spelling per machine, because the three tools disagree: dpkg says
 * arm64/amd64, rpm and `uname -m` say aarch64/x86_64. "any" is dpkg's `all`
 * and rpm's `noarch`, which install on every machine.
 */
export function normalizeArch(value) {
  const arch = String(value ?? "").trim().toLowerCase();
  if (arch === "arm64" || arch === "aarch64" || arch === "armv8") return "aarch64";
  if (arch === "amd64" || arch === "x86_64" || arch === "x64") return "x86_64";
  if (arch === "all" || arch === "noarch") return "any";
  return arch;
}

/** Whether a package built for `packageArch` may be installed on `hostArch`. */
export function archMatches(packageArch, hostArch) {
  const wanted = normalizeArch(packageArch);
  return wanted === "any" || wanted === normalizeArch(hostArch);
}

/** The image each kind is tested in. AppImage reuses the unpacked runner's. */
export function imageTagFor(kind) {
  if (kind === "appimage") return "crossplat-linux-smoke:1";
  if (kind === "deb") return "crossplat-linux-deb-smoke:1";
  if (kind === "rpm") return "crossplat-linux-rpm-smoke:1";
  return null;
}

/**
 * Where each image is built from, relative to scripts/crossplat. AppImage uses
 * the unpacked runner's image, which already carries the desktop libraries an
 * AppImage expects to find on the system; deb and rpm deliberately do NOT, so
 * an undeclared dependency fails the install rather than passing unnoticed.
 */
export function dockerfileFor(kind) {
  if (kind === "appimage") return { context: "linux-smoke", dockerfile: null };
  if (kind === "deb") return { context: "linux-package-smoke", dockerfile: "Dockerfile.deb" };
  if (kind === "rpm") return { context: "linux-package-smoke", dockerfile: "Dockerfile.rpm" };
  return null;
}

/**
 * How to install one package with its own package manager, so declared
 * dependencies are really resolved. Weak dependencies (deb Recommends, rpm
 * Recommends/Suggests) are left out by default: they are what a package falls
 * back on when Depends is under-declared, and installing them would hide the
 * bug this test exists to find. `recommends: true` asks for a plain
 * `apt install ./file.deb`, which is what a person gets.
 */
export function installCommand(kind, file, options = {}) {
  const weak = options.recommends === true;
  if (kind === "deb") return ["apt-get", "install", "-y", ...(weak ? [] : ["--no-install-recommends"]), file];
  if (kind === "rpm") return ["dnf", "install", "-y", ...(weak ? [] : ["--setopt=install_weak_deps=False"]), file];
  return null;
}

/** Desktop Entry field codes, which are arguments to the launcher, not the program. */
const FIELD_CODE = /^%[fFuUdDnNickvm]$/;

/**
 * The `[Desktop Entry]` group of a .desktop file as a flat object. Later
 * groups ([Desktop Action ...]) are ignored, and the first value of a repeated
 * key wins, as the spec says. Localised keys keep their brackets (`Name[de]`),
 * so they never displace the unlocalised one.
 */
export function parseDesktopEntry(text) {
  const entry = {};
  let inEntry = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (Object.hasOwn(entry, key)) continue;
    entry[key] = line.slice(eq + 1).trim();
  }
  return entry;
}

/**
 * The program an `Exec=` line runs, with the field codes dropped. electron-builder
 * writes `Exec="/opt/App Name/binary" %U`, so the quoted form with a space in
 * the path is the normal case rather than an edge one; a first token that is
 * only a field code, or an empty line, gives null.
 */
export function desktopExecPath(exec) {
  const value = String(exec ?? "").trim();
  if (value === "") return null;
  if (value.startsWith('"')) {
    let out = "";
    for (let i = 1; i < value.length; i++) {
      const ch = value[i];
      // Inside a quoted argument the spec escapes `"` and `\` with a backslash.
      if (ch === "\\" && i + 1 < value.length) {
        out += value[i + 1];
        i++;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out === "" ? null : out;
  }
  const first = value.split(/\s+/)[0];
  if (first === "" || FIELD_CODE.test(first)) return null;
  return first;
}

/**
 * What an `Icon=` value may point at: an absolute file, or a themed name to
 * look for under the icon directories. The extensions are the ones the icon
 * theme specification allows.
 */
export function iconLookup(icon) {
  const value = String(icon ?? "").trim();
  if (value === "") return { absolute: null, names: [] };
  if (value.startsWith("/")) return { absolute: value, names: [] };
  return { absolute: null, names: [".png", ".svg", ".xpm"].map((ext) => `${value}${ext}`) };
}

/**
 * Extra `docker run` flags an AppImage needs. The default, `extract`, unpacks
 * the image with its own `--appimage-extract` and runs the AppDir, because a
 * container has no /dev/fuse and the runtime would otherwise fail to mount
 * itself — the same reason `--appimage-extract-and-run` exists. `fuse` tests
 * the mounting path instead and needs the device and the capability for it,
 * which is why it is opt-in rather than the default.
 */
export function appimageDockerFlags(mode) {
  if (mode !== "fuse") return [];
  return ["--device", "/dev/fuse", "--cap-add", "SYS_ADMIN", "--security-opt", "apparmor:unconfined"];
}

/** The AppImage run modes, in the order they are documented. */
export const APPIMAGE_MODES = ["extract", "fuse"];
