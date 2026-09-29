import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactArch,
  outDirFor,
  planPackageRuns,
} from "../desktop-packages-smoke.mjs";
import { buildArgsFor, parsePackageSmokeArgs } from "../crossplat/linux-package-smoke.mjs";
import {
  APPIMAGE_MODES,
  appimageDockerFlags,
  archMatches,
  desktopExecPath,
  dockerfileFor,
  iconLookup,
  imageTagFor,
  installCommand,
  normalizeArch,
  packageKind,
  parseDesktopEntry,
} from "../crossplat/linux-package-smoke/package-lib.mjs";

// The packaged Linux smoke test (pnpm test:desktop:packages) installs a real
// .AppImage, .deb or .rpm in Docker and drives it over CDP. None of that can
// run here, so these tests pin the rules that decide WHAT it does: which image
// a package goes to, how it is installed, and where the program and icon are
// found once it is. Each was written against a real v0.1.2 artifact.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("packageKind", () => {
  it("names the three packaged artifacts, case-insensitively", () => {
    assert.equal(packageKind("TrackYourTime-0.1.2-linux-arm64.AppImage"), "appimage");
    assert.equal(packageKind("trackyourtime_0.1.2_arm64.deb"), "deb");
    assert.equal(packageKind("trackyourtime-0.1.2.aarch64.rpm"), "rpm");
    assert.equal(packageKind("thing.APPIMAGE"), "appimage");
  });

  it("refuses everything else, so an unpacked build is not mistaken for a package", () => {
    for (const file of ["release/linux-arm64-unpacked", "app.tar.gz", "latest-linux-arm64.yml", "", null]) {
      assert.equal(packageKind(file), null, `${file} should not be a package`);
    }
  });
});

describe("normalizeArch / archMatches", () => {
  it("reconciles the three spellings the tools use", () => {
    // dpkg says arm64/amd64, rpm and uname say aarch64/x86_64.
    assert.equal(normalizeArch("arm64"), "aarch64");
    assert.equal(normalizeArch("aarch64"), "aarch64");
    assert.equal(normalizeArch("amd64"), "x86_64");
    assert.equal(normalizeArch("x86_64"), "x86_64");
    assert.equal(normalizeArch(" X64 "), "x86_64");
  });

  it("reads dpkg's `all` and rpm's `noarch` as installable anywhere", () => {
    assert.equal(normalizeArch("all"), "any");
    assert.equal(normalizeArch("noarch"), "any");
    assert.ok(archMatches("all", "aarch64"));
    assert.ok(archMatches("noarch", "x86_64"));
  });

  it("refuses the other architecture rather than emulating it", () => {
    assert.ok(archMatches("arm64", "aarch64"));
    assert.ok(!archMatches("amd64", "aarch64"));
    assert.ok(!archMatches("aarch64", "x86_64"));
  });
});

describe("imageTagFor / dockerfileFor", () => {
  it("sends an AppImage to the unpacked runner's image, which has the desktop libraries", () => {
    // An AppImage bundles the app and expects a normal desktop underneath it,
    // so it is tested in the image that has one.
    assert.equal(imageTagFor("appimage"), "crossplat-linux-smoke:1");
    assert.deepEqual(dockerfileFor("appimage"), { context: "linux-smoke", dockerfile: null });
  });

  it("gives deb and rpm their own bare images, which is the whole point", () => {
    // Neither carries an Electron runtime library, so the package's own
    // Depends/Requires has to supply them.
    assert.equal(imageTagFor("deb"), "crossplat-linux-deb-smoke:1");
    assert.equal(imageTagFor("rpm"), "crossplat-linux-rpm-smoke:1");
    assert.deepEqual(dockerfileFor("deb"), { context: "linux-package-smoke", dockerfile: "Dockerfile.deb" });
    assert.deepEqual(dockerfileFor("rpm"), { context: "linux-package-smoke", dockerfile: "Dockerfile.rpm" });
  });

  it("names no image for something that is not a package", () => {
    assert.equal(imageTagFor("tarball"), null);
    assert.equal(dockerfileFor("tarball"), null);
  });

  it("points docker build at a context and Dockerfile that exist", () => {
    for (const kind of ["appimage", "deb", "rpm"]) {
      const args = buildArgsFor(kind, join(repoRoot, "scripts/crossplat"));
      const context = args[args.length - 1];
      assert.ok(existsSync(context), `${kind}: missing context ${context}`);
      const fileFlag = args.indexOf("-f");
      if (fileFlag !== -1) assert.ok(existsSync(args[fileFlag + 1]), `${kind}: missing Dockerfile`);
      else assert.ok(existsSync(join(context, "Dockerfile")), `${kind}: missing default Dockerfile`);
    }
  });

  it("builds the bare images from a base that carries no Electron runtime library", () => {
    // The test is only honest while these images stay bare: a GTK or NSS
    // package added here would satisfy a dependency the artifact forgot.
    const forbidden = /\b(libgtk-3-0|gtk3|libnss3|nss|libgbm1|mesa-libgbm|libasound2|alsa-lib)\b/;
    for (const name of ["Dockerfile.deb", "Dockerfile.rpm"]) {
      // The comments name these libraries to explain why they are absent, so
      // only the directives are read.
      const directives = readFileSync(join(repoRoot, "scripts/crossplat/linux-package-smoke", name), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      assert.ok(!forbidden.test(directives), `${name} installs an Electron runtime library, which hides a missing dependency`);
    }
  });
});

describe("installCommand", () => {
  it("installs a .deb with apt so its Depends are really resolved", () => {
    // `apt-get install ./file.deb` is the step that fails when a dependency is
    // missing; `dpkg -i` would install it anyway and only warn.
    assert.deepEqual(installCommand("deb", "/pkg/a.deb"), [
      "apt-get", "install", "-y", "--no-install-recommends", "/pkg/a.deb",
    ]);
  });

  it("installs an .rpm with dnf, for the same reason", () => {
    assert.deepEqual(installCommand("rpm", "/pkg/a.rpm"), [
      "dnf", "install", "-y", "--setopt=install_weak_deps=False", "/pkg/a.rpm",
    ]);
  });

  it("leaves weak dependencies out by default, because they mask an under-declared Depends", () => {
    assert.ok(installCommand("deb", "/pkg/a.deb").includes("--no-install-recommends"));
    assert.ok(installCommand("rpm", "/pkg/a.rpm").includes("--setopt=install_weak_deps=False"));
  });

  it("--with-recommends asks for what a person actually gets", () => {
    assert.deepEqual(installCommand("deb", "/pkg/a.deb", { recommends: true }), ["apt-get", "install", "-y", "/pkg/a.deb"]);
    assert.deepEqual(installCommand("rpm", "/pkg/a.rpm", { recommends: true }), ["dnf", "install", "-y", "/pkg/a.rpm"]);
  });

  it("has no install command for an AppImage, which installs nothing", () => {
    assert.equal(installCommand("appimage", "/pkg/a.AppImage"), null);
  });
});

describe("parseDesktopEntry", () => {
  // The real entry out of trackyourtime_0.1.2_arm64.deb.
  const REAL = `[Desktop Entry]
Name=Track Your Time
Exec="/opt/Track Your Time/trackyourtime" %U
Terminal=false
Type=Application
Icon=trackyourtime
StartupWMClass=Track Your Time
Comment=A simple time tracker application
Categories=Utility;
`;

  it("reads the shipped entry", () => {
    const entry = parseDesktopEntry(REAL);
    assert.equal(entry.Name, "Track Your Time");
    assert.equal(entry.Exec, '"/opt/Track Your Time/trackyourtime" %U');
    assert.equal(entry.Icon, "trackyourtime");
  });

  it("reads only the [Desktop Entry] group", () => {
    const entry = parseDesktopEntry(`[Desktop Entry]\nExec=/a\n\n[Desktop Action New]\nExec=/b\n`);
    assert.equal(entry.Exec, "/a");
  });

  it("keeps a localised key apart from the plain one", () => {
    // `Name[de]` must never displace `Name`, or the smoke reports a translated
    // program name as the one to start.
    const entry = parseDesktopEntry(`[Desktop Entry]\nName=Track Your Time\nName[de]=Zeit erfassen\n`);
    assert.equal(entry.Name, "Track Your Time");
    assert.equal(entry["Name[de]"], "Zeit erfassen");
  });

  it("ignores comments, blank lines and anything before the group", () => {
    const entry = parseDesktopEntry(`# a comment\nStray=1\n\n[Desktop Entry]\n# another\nExec=/a\n`);
    assert.deepEqual(entry, { Exec: "/a" });
  });

  it("lets the first value of a repeated key win, as the spec says", () => {
    assert.equal(parseDesktopEntry(`[Desktop Entry]\nExec=/first\nExec=/second\n`).Exec, "/first");
  });
});

describe("desktopExecPath", () => {
  it("unquotes the path electron-builder writes, spaces and all", () => {
    // The quoted form with a space is the normal case here, not an edge one:
    // the app installs to "/opt/Track Your Time".
    assert.equal(desktopExecPath('"/opt/Track Your Time/trackyourtime" %U'), "/opt/Track Your Time/trackyourtime");
  });

  it("drops the field codes, which are the launcher's arguments and not the program", () => {
    assert.equal(desktopExecPath("/usr/bin/app %U"), "/usr/bin/app");
    assert.equal(desktopExecPath("/usr/bin/app %f %i %c"), "/usr/bin/app");
  });

  it("unescapes a quoted argument the way the spec escapes it", () => {
    assert.equal(desktopExecPath('"/opt/a \\"b\\"/app" %U'), '/opt/a "b"/app');
    assert.equal(desktopExecPath('"/opt/a\\\\b/app"'), "/opt/a\\b/app");
  });

  it("gives null for nothing to run, so the caller fails loudly", () => {
    assert.equal(desktopExecPath(""), null);
    assert.equal(desktopExecPath("   "), null);
    assert.equal(desktopExecPath(undefined), null);
    assert.equal(desktopExecPath("%U"), null);
  });
});

describe("iconLookup", () => {
  it("takes an absolute Icon= as a file to check", () => {
    assert.deepEqual(iconLookup("/usr/share/pixmaps/app.png"), { absolute: "/usr/share/pixmaps/app.png", names: [] });
  });

  it("turns a themed name into the file names the icon theme spec allows", () => {
    // v0.1.2 ships Icon=trackyourtime plus
    // /usr/share/icons/hicolor/512x512/apps/trackyourtime.png.
    assert.deepEqual(iconLookup("trackyourtime"), {
      absolute: null,
      names: ["trackyourtime.png", "trackyourtime.svg", "trackyourtime.xpm"],
    });
  });

  it("has nothing to look for when Icon= is absent", () => {
    assert.deepEqual(iconLookup(""), { absolute: null, names: [] });
    assert.deepEqual(iconLookup(undefined), { absolute: null, names: [] });
  });
});

describe("appimageDockerFlags", () => {
  it("adds nothing for the default, which unpacks instead of mounting", () => {
    // A container has no /dev/fuse, so the runtime cannot mount itself; the
    // installer runs --appimage-extract and starts the AppDir.
    assert.deepEqual(appimageDockerFlags("extract"), []);
  });

  it("adds the FUSE device only when the mounting path is asked for", () => {
    const flags = appimageDockerFlags("fuse");
    assert.ok(flags.includes("/dev/fuse"));
    assert.ok(flags.includes("SYS_ADMIN"));
  });

  it("offers exactly the two documented modes", () => {
    assert.deepEqual(APPIMAGE_MODES, ["extract", "fuse"]);
  });
});

describe("parsePackageSmokeArgs", () => {
  it("requires a package", () => {
    assert.match(parsePackageSmokeArgs([]).error, /--package is required/);
  });

  it("collects repeatable --env and --arg", () => {
    const { opts } = parsePackageSmokeArgs([
      "--package", "/p/a.deb",
      "--env", "A=1", "--env", "B=2",
      "--arg", "--flag",
    ]);
    assert.deepEqual(opts.env, ["A=1", "B=2"]);
    assert.deepEqual(opts.arg, ["--flag"]);
  });

  it("reads --with-recommends as a bare switch, with no value after it", () => {
    const { opts } = parsePackageSmokeArgs(["--package", "/p/a.deb", "--with-recommends"]);
    assert.equal(opts.withRecommends, true);
    assert.equal(opts.package, "/p/a.deb");
  });

  it("defaults to a longer timeout than the unpacked runner, because an install runs first", () => {
    const { opts } = parsePackageSmokeArgs(["--package", "/p/a.deb"]);
    assert.equal(opts.timeoutMs, "90000");
    assert.equal(opts.appimageMode, "extract");
  });

  it("refuses an unknown option and an unknown AppImage mode", () => {
    assert.match(parsePackageSmokeArgs(["--package", "/p/a.deb", "--nope", "1"]).error, /unknown option/);
    assert.match(parsePackageSmokeArgs(["--package", "/p/a.deb", "--appimage-mode", "magic"]).error, /--appimage-mode/);
  });

  it("refuses a value-taking flag with nothing after it", () => {
    assert.match(parsePackageSmokeArgs(["--package"]).error, /needs a value/);
  });
});

describe("artifactArch", () => {
  it("reads the architecture out of the names this project's releases use", () => {
    assert.equal(artifactArch("TrackYourTime-0.1.2-linux-arm64.AppImage"), "aarch64");
    assert.equal(artifactArch("TrackYourTime-0.1.2-linux-x86_64.AppImage"), "x86_64");
    assert.equal(artifactArch("trackyourtime_0.1.2_arm64.deb"), "aarch64");
    assert.equal(artifactArch("trackyourtime_0.1.2_amd64.deb"), "x86_64");
    assert.equal(artifactArch("trackyourtime-0.1.2.aarch64.rpm"), "aarch64");
    assert.equal(artifactArch("trackyourtime-0.1.2.x86_64.rpm"), "x86_64");
  });

  it("reads a full path, not only a bare name", () => {
    assert.equal(artifactArch("/tmp/x/trackyourtime_0.1.2_arm64.deb"), "aarch64");
  });

  it("gives null when the name says nothing, so the runner skips rather than guesses", () => {
    assert.equal(artifactArch("trackyourtime.deb"), null);
  });
});

describe("planPackageRuns", () => {
  const FILES = [
    "release/TrackYourTime-0.1.2-linux-arm64.AppImage",
    "release/TrackYourTime-0.1.2-linux-x86_64.AppImage",
    "release/trackyourtime_0.1.2_arm64.deb",
    "release/trackyourtime-0.1.2.x86_64.rpm",
  ];

  it("runs only the daemon's own architecture and skips the other with a reason", () => {
    // Emulating the other architecture would test qemu rather than the package.
    const plan = planPackageRuns(FILES, "aarch64");
    assert.deepEqual(plan.map((step) => step.run), [true, false, true, false]);
    for (const step of plan.filter((s) => !s.run)) assert.match(step.reason, /built for x86_64/);
  });

  it("flips with the daemon", () => {
    assert.deepEqual(planPackageRuns(FILES, "x86_64").map((step) => step.run), [false, true, false, true]);
  });

  it("skips, rather than fails, a name whose architecture it cannot read", () => {
    const [step] = planPackageRuns(["release/mystery.deb"], "aarch64");
    assert.equal(step.run, false);
    assert.match(step.reason, /architecture is not in the file name/);
  });
});

describe("outDirFor", () => {
  it("gives each kind and architecture its own results directory", () => {
    // Two runs in one invocation must not overwrite each other's screenshot.
    assert.equal(outDirFor("release/trackyourtime_0.1.2_arm64.deb"), join("test-results", "linux-packages", "deb-aarch64"));
    assert.equal(outDirFor("release/trackyourtime-0.1.2.x86_64.rpm"), join("test-results", "linux-packages", "rpm-x86_64"));
    assert.equal(
      outDirFor("release/TrackYourTime-0.1.2-linux-arm64.AppImage"),
      join("test-results", "linux-packages", "appimage-aarch64"),
    );
  });
});

describe("the crossplat folder stays project-agnostic", () => {
  it("names no app and imports nothing from this repository", () => {
    // scripts/crossplat/ is copied into other projects and is headed for
    // hatchkit (scripts/crossplat/README.md). All wiring belongs in
    // scripts/desktop-packages-smoke.mjs and package.json.
    const files = [
      "linux-package-smoke.mjs",
      "linux-package-smoke/package-lib.mjs",
      "linux-package-smoke/install.mjs",
      "linux-package-smoke/Dockerfile.deb",
      "linux-package-smoke/Dockerfile.rpm",
      "linux-smoke/probe.mjs",
    ];
    for (const name of files) {
      const text = readFileSync(join(repoRoot, "scripts/crossplat", name), "utf8");
      assert.ok(!/trackyourtime|Track Your Time/i.test(text), `${name} names the app`);
      assert.ok(!/from "\.\.\/\.\.\//.test(text), `${name} imports from outside scripts/crossplat`);
    }
  });
});

describe("the packaging declares what the app links against", () => {
  // v0.1.2 shipped a .deb that died on `libgbm.so.1: cannot open shared object
  // file` and an .rpm that died on `libasound.so.2`, both found by this smoke
  // test. electron-builder's `depends` REPLACES its defaults, so the config has
  // to repeat them; dropping one is silent until an install fails.
  const config = readFileSync(join(repoRoot, "electron-builder.config.mjs"), "utf8");

  it("keeps the .deb's Depends complete", () => {
    for (const name of ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libgbm1", "libasound2"]) {
      assert.ok(config.includes(`"${name}"`), `deb depends is missing ${name}`);
    }
  });

  it("keeps the .rpm's Requires complete", () => {
    for (const name of ["gtk3", "libnotify", "nss", "libXScrnSaver", "xdg-utils", "at-spi2-core", "alsa-lib", "mesa-libgbm", "libsecret"]) {
      assert.ok(config.includes(`"${name}"`), `rpm depends is missing ${name}`);
    }
  });
});
