# crossplat — try a build on the other desktop platforms

Two small tools for testing a desktop app on Windows and Linux from a Mac.
They are **project-agnostic**: nothing in this folder imports from the
repository around it or names an app. Copy the folder into another project
unchanged. It is meant to move into hatchkit later, so every project it
generates can use the same flow. Keep it self-contained until then.

| Tool | What it does | Who runs it |
|---|---|---|
| `vm-drop.mjs` | Copies a build into one shared drop folder, `~/VMShare`, next to a double-click launcher. A Windows or Linux VM opens that folder. | People |
| `linux-smoke.mjs` | Starts an unpacked Electron Linux build in Docker under Xvfb, drives it over CDP and saves a screenshot. Passes or fails. | Agents, CI, people |
| `linux-package-smoke.mjs` | Installs ONE packaged artifact — `.AppImage`, `.deb` or `.rpm` — in Docker under Xvfb, then drives it with the same probe. Passes or fails. | Agents, CI, people |

Requires Node 20 or later. Uses no npm dependencies on the host.

## One drop folder for every project

```
~/VMShare/                       (CROSSPLAT_SHARE moves it)
  INDEX.txt                      every drop, newest first
  trackyourtime/windows-arm64/   app/  run.cmd  DROP.json
  raptor-runner/windows-arm64/   app/  run.cmd  DROP.json
  tiao/windows-x64/              app/Tiao_1.2.0_x64-setup.exe  run.cmd  DROP.json
```

Set up one Windows VM and one Linux VM and share this folder with them once.
From then on, every project's builds appear there. In the VM, double-click
`<project>\<platform>\run.cmd` (or `run.sh` on Linux). The launcher mirrors
the drop to the guest's own disk and starts it from there, because:

- Windows' WebDAV client, which UTM's built-in shared directory uses, refuses
  files over 50 MB. An Electron main executable is about 200 MB.
- An app that runs straight from a share locks its files, and the host can
  then not replace them on the next drop.

## vm-drop.mjs

```bash
node scripts/crossplat/vm-drop.mjs \
  --project <slug> --platform <windows|linux>-<x64|arm64> \
  --source <unpacked dir or single file> --launch <exe inside the dir> \
  [--note "what is baked in"] [--start-vm "<UTM VM name>"]
```

- `--source` can be a folder (an unpacked electron-builder build) or one file
  (an installer from CI, such as a Tauri `.msi` or `-setup.exe`). With a file,
  the launcher runs that file.
- The drop is written next to the old one and swapped in whole, so a guest
  never sees a mix of two builds.
- `DROP.json` records the commit, whether the tree was dirty, the source path
  and the note.
- `--start-vm`, or the `CROSSPLAT_UTM_VM` environment variable, starts that
  UTM VM through `utmctl`. This opens UTM's window, so leave it off in agent
  and CI runs.

## linux-smoke.mjs

```bash
node scripts/crossplat/linux-smoke.mjs \
  --app-dir release/linux-arm64-unpacked --exec <binary> \
  [--expect-url-prefix app://-] [--env KEY=VALUE]... [--arg --flag]... \
  [--settle-ms 5000] [--timeout-ms 60000] [--out test-results/linux-smoke]
```

The test passes when all of these are true:

- the app opens its CDP port;
- a page with the expected URL prefix appears;
- the page throws no uncaught error;
- a screenshot succeeds;
- the process is still running after the settle time.

It writes `result.json`, `screenshot.png` and `app.log` to `--out`. Console
errors are reported but do not fail the run, because an app with no server
behind it logs refused requests.

Requirements and rules:

- **A Docker daemon of the build's architecture.** On an Apple Silicon Mac,
  run `brew install docker colima` and then `colima start`, and build the
  app for arm64. OrbStack and Docker Desktop work too. The runner refuses a
  binary built for the wrong architecture instead of emulating it.
- **The window must be shown.** On X11, a window that was never shown gives
  CDP no frames, and the screenshot waits forever. If the app has its own
  "headless" switch, leave it off here. Xvfb is a virtual display, so nothing
  reaches a real screen.
- The app runs as the calling user with `--no-sandbox`, a session D-Bus and
  `HOME=/tmp`. System D-Bus errors in `app.log` are expected.
- The image, `crossplat-linux-smoke:1`, is built from `linux-smoke/Dockerfile`
  on the first run and cached after that. Change the tag when the Dockerfile
  changes.

## linux-package-smoke.mjs

```bash
node scripts/crossplat/linux-package-smoke.mjs \
  --package release/myapp_1.2.3_arm64.deb \
  [--expect-url-prefix app://-] [--exec "/opt/My App/myapp"] \
  [--appimage-mode extract|fuse] [--with-recommends] \
  [--env KEY=VALUE]... [--arg --flag]... \
  [--settle-ms 5000] [--timeout-ms 90000] [--out <dir>]
```

`linux-smoke.mjs` takes an **unpacked** build, so it never exercises the
packaging itself: the desktop entry, the icon paths, the AppImage runtime, the
declared dependencies and the install scriptlets. This one takes a **packaged**
file and installs it the way a person would.

| Kind | Image | How it is installed |
|---|---|---|
| `.deb` | `Dockerfile.deb` (`node:24-bookworm-slim`) | `apt-get install ./file.deb` |
| `.rpm` | `Dockerfile.rpm` (`fedora:41`) | `dnf install ./file.rpm` |
| `.AppImage` | the `linux-smoke` image | `chmod +x`, then `--appimage-extract` and run the AppDir |

**The deb and rpm images carry no Electron runtime library on purpose.** They
have a virtual display, a session bus, Node and playwright-core, and nothing
else — so `apt`/`dnf` has to pull GTK, NSS and the rest out of the package's own
`Depends`/`Requires`. A dependency the package forgot then fails the install
instead of being satisfied by accident, which is the bug this tool exists to
find. Do not add a runtime library to either Dockerfile. Weak dependencies
(deb `Recommends`, rpm `Recommends`) are left out for the same reason;
`--with-recommends` asks for the plain `apt install ./x.deb` a person gets.

The AppImage image is the other way round: an AppImage bundles the app and
expects an ordinary desktop underneath it, so it is tested in the image that has
one.

**AppImage and FUSE.** A container has no `/dev/fuse`, so the AppImage runtime
cannot mount itself. The default mode, `extract`, unpacks the image with its own
`--appimage-extract` and starts the AppDir — what `--appimage-extract-and-run`
does. `--appimage-mode fuse` tests the mounting path instead, and the runner
adds `--device /dev/fuse --cap-add SYS_ADMIN` for it. The difference is a flag
rather than an accident, because an AppImage that only works one way is worth
knowing about.

After the install it reads the installed `.desktop` file, checks that its `Exec`
resolves to an executable that exists and that its `Icon` matches a real icon
file, and starts that program — so the launcher's own path is what gets tested.
`--exec` overrides it. The program is then handed to `linux-smoke/probe.mjs`,
reused byte-for-byte, so the pass criteria are the unpacked runner's:

- the app opens its CDP port;
- a page with the expected URL prefix appears;
- the page throws no uncaught error;
- a screenshot succeeds;
- the process is still running after the settle time.

It writes `install.json` beside the probe's `result.json`, `screenshot.png` and
`app.log`.

Requirements and rules, beyond `linux-smoke.mjs`'s:

- **The package must sit under a path the Docker daemon shares with the host.**
  colima shares the home directory but not `/tmp`, so a package downloaded to
  `/tmp` is invisible inside the container; the installer says so rather than
  reporting a missing file.
- **The container runs as root**, because installing a package does. The output
  directory is given back to the calling user before it exits.
- **The architecture is read with the package's own tool** — `dpkg-deb -f`,
  `rpm -qp`, the ELF header — and a package for the other architecture is
  refused rather than emulated.
- The images are `crossplat-linux-deb-smoke:1` and `crossplat-linux-rpm-smoke:1`,
  built on the first run and cached. Change the tag when a Dockerfile changes.

## Per stack

| Stack | Windows build on a Mac | Linux smoke |
|---|---|---|
| Electron + electron-builder | `electron-builder --win --arm64 --dir` works on macOS with no Wine (checked with electron-builder 26). Drop `win-arm64-unpacked/`. | Build `--linux --arm64 --dir`, then run `linux-smoke.mjs`. |
| Tauri | Cross-compiling for Windows is not practical. Download the installer from CI (`gh run download <run> -n <artifact>`) and drop that file. | Not covered: Tauri uses WebKitGTK, not Chromium, so there is no CDP endpoint. |

## For each project that adopts this

1. Copy this folder unchanged.
2. Add a `prod:win` script that builds the app and runs `vm-drop.mjs`.
3. For Electron apps, add a smoke script that builds for the Docker host's
   architecture and runs `linux-smoke.mjs`.
4. For Electron apps that ship Linux packages, add a second smoke script that
   runs `linux-package-smoke.mjs` over each built package, skipping the
   architectures the local daemon cannot run.

Track Your Time's wiring is in its `package.json` (`prod:win`,
`test:desktop:linux`, `test:desktop:packages`), `scripts/desktop-linux-smoke.mjs`
and `scripts/desktop-packages-smoke.mjs` — which is where the app's names, paths
and release-file naming live, never in this folder. The one-time VM setup is in
`docs/cross-platform-testing.md`.
