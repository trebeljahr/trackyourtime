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

Track Your Time's wiring is in its `package.json` (`prod:win`,
`test:desktop:linux`) and `scripts/desktop-linux-smoke.mjs`. The one-time VM
setup is in `docs/cross-platform-testing.md`.
