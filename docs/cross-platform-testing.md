# Trying the desktop app on Windows and Linux

The desktop app is Tauri 2 (`desktop/src-tauri`): one Rust executable with the
static export inside it, on the system WebView — WebView2 on Windows,
WebKitGTK on Linux. Three commands, built on the project-agnostic tools in
`scripts/crossplat/`:

```bash
pnpm prod:win                       # Windows arm64 build against api.trackyourtime.dev, dropped for a UTM VM
pnpm desktop:try-release 0.4.0      # the file a release published, downloaded and dropped for a VM
pnpm test:desktop:linux             # Linux build, started in Docker under Xvfb: pass/fail + screenshot
```

`prod:win` and `desktop:try-release` are for a person, like `prod:desktop`:
they put an app in front of you in a VM and you run it by hand.
`test:desktop:linux` is safe for agents and CI, because nothing opens on the
host's screen.

The first two answer different questions. `prod:win` cross-builds an **unpacked**
app on this Mac, which tests the code; `desktop:try-release` downloads the
**installer or AppImage a user downloads**, which tests what the release
workflow actually produced — the packaging, the installer, the file's own
integrity. Use it before publishing a draft release.

## pnpm prod:win

1. The command cross-builds the unpacked Windows arm64 app on the Mac:
   `tauri build --runner cargo-xwin --target aarch64-pc-windows-msvc --no-bundle`
   (`scripts/build-desktop.mjs --package --dir --target …`). The app is one
   executable, `release/win-arm64-unpacked/Track Your Time.exe`.
2. It copies the build to `~/VMShare/trackyourtime/windows-arm64/`, next to
   `run.cmd`.
3. In the Windows VM, open the share and double-click
   `trackyourtime\windows-arm64\run.cmd`. The launcher copies the build to
   `%LOCALAPPDATA%\crossplat\` and starts it.

The cross build needs, once: `cargo install --locked cargo-xwin`,
`rustup target add aarch64-pc-windows-msvc` and `brew install llvm` (clang-cl
and lld-link). cargo-xwin downloads the MSVC CRT and Windows SDK headers on
first use, after accepting their licence on your behalf; read
<https://github.com/rust-cross/cargo-xwin> before the first run. The installer
(NSIS) is never built on a Mac: the release workflow builds it on Windows.

Quit the app in the VM before the next drop. Otherwise the launcher cannot
replace the files it is still running.

The build is arm64 to match a Windows VM on Apple Silicon. Most Windows users
have x64 machines; the release workflow builds both on a real Windows runner.
The app needs the WebView2 runtime, which Windows 11 ships with.

Windows shows a SmartScreen warning ("Windows protected your PC") because the
build is unsigned. Click **More info**, then **Run anyway**.

To start the VM automatically after each drop, set the VM's name in your shell
profile. This opens UTM's window.

```bash
export CROSSPLAT_UTM_VM="Windows 11"
```

### Against a local API instead

The VM reaches the Mac at `192.168.64.1` on UTM's default Shared Network. The
dev server listens on every interface. On Windows the app's document origin is
`http://app.localhost` (WebView2 serves a custom scheme that way), which the
dev server trusts with the other desktop origins. So pin the API port, then
bake that address into the build:

```bash
API_PORT=51590 PORT=33920 pnpm run dev
```

```bash
NEXT_PUBLIC_API_URL=http://192.168.64.1:51590 node scripts/build-desktop.mjs --package --dir --target aarch64-pc-windows-msvc && node scripts/crossplat/vm-drop.mjs --project trackyourtime --platform windows-arm64 --source release/win-arm64-unpacked --launch "Track Your Time.exe" --note "local API"
```

## pnpm desktop:try-release

```bash
pnpm desktop:try-release 0.4.0                  # Linux arm64 AppImage (the default)
pnpm desktop:try-release v0.4.0 linux-x64
pnpm desktop:try-release 0.4.0 windows-arm64
pnpm desktop:try-release 0.4.0 --start-vm "Ubuntu 24.04"
```

1. It asks `gh` for that release — a **draft** counts, which is where every
   release sits until a person publishes it (CLAUDE.md → desktop release).
2. It downloads the one asset that platform can start by itself, and the
   release's `SHA256SUMS.txt`, and refuses the drop if the sha256 does not
   match. An AppImage that arrived short should fail here, not in the VM.
3. It hands the file to `scripts/crossplat/vm-drop.mjs`, which writes
   `~/VMShare/trackyourtime/<platform>/` with the asset, a `run.sh` (or
   `run.cmd`) and a `DROP.json` noting the tag.
4. In the VM, double-click the launcher. It copies the file to the guest's own
   disk, marks it executable and starts it.

The version may be written `0.4.0` or `v0.4.0`. No VM is started unless
`--start-vm` names one (or `CROSSPLAT_UTM_VM` is exported), because that opens
UTM's window.

| Flag | Effect |
|---|---|
| `--repo owner/name` | Read the release from a fork instead of `trebeljahr/trackyourtime` |
| `--note "…"` | Replace the `DROP.json` note, which defaults to `<tag>, from the GitHub release` |
| `--start-vm "<UTM VM>"` | Start that UTM VM after the drop |

### One asset per platform

| Platform | Asset |
|---|---|
| `linux-arm64` | `TrackYourTime-<version>-linux-arm64.AppImage` |
| `linux-x64` | `TrackYourTime-<version>-linux-x86_64.AppImage` (the machine's own arch string, as every release has named it) |
| `windows-x64` | `TrackYourTime-Setup-<version>.exe` |
| `windows-arm64` | `TrackYourTime-Setup-<version>-arm64.exe`; up to 0.3.0 (Electron) one installer carried both, so those releases give `TrackYourTime-Setup-<version>.exe` |

The deb, rpm and tar.gz on a release are installs and archives, not files a
launcher can execute, so the command does not offer them. Fetch one by hand
with `gh release download <tag> --repo trebeljahr/trackyourtime --pattern
"*.deb"`.

### Windows asks for a file that is not there

```
desktop:try-release — v0.4.0 publishes no Windows asset (TrackYourTime-Setup-0.4.0.exe
  is not there), so there is nothing a Windows VM can install.
```

That is not a bug in the command: that release's Windows leg was built
unsigned. With no certificate (`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`, or
Azure Trusted Signing) the release workflow builds Windows as `-unsigned`, and
it never attaches an `-unsigned` file to a release (docs/deploy.md → "Desktop
release"). Then `pnpm prod:win` is the way to try the app on Windows, and the
command says so and exits non-zero.

## pnpm test:desktop:linux

The command builds the unpacked Linux app for the Docker daemon's architecture
(arm64 on this Mac, x64 on an x64 runner). The build points at a closed
loopback port, `127.0.0.1:59999`, so no server is needed. On Linux it is
`build-desktop.mjs --package --dir`; on a Mac, which has no WebKitGTK to link
against, the Rust build runs in a container of the daemon's architecture
(`scripts/desktop/linux-build.Dockerfile`), from the export built on the host,
into `desktop/target/linux-docker/`. The first build there takes a while (2
CPUs and 2 GB in colima's default VM); later ones reuse the target directory.

It then starts the app in a container, under Xvfb, **in its smoke mode**: with
`TRACKYOURTIME_SMOKE_REPORT=<path>` (release builds honour it too) the app
loads, waits for its page, writes `{ ok, href, title, bridge, platform,
bodyText, problems }` there and exits, 0 on ok. A WebKitGTK app has no CDP, so
that report is the verdict, through the probe's `report` mode
(`scripts/crossplat/linux-smoke/probe.mjs`). It passes when:

- the report says `ok` — the bridge is installed, the page rendered text, and
  no page error or CSP violation was collected;
- the page is at `app://-`;
- the app exited 0;
- Xvfb showed a non-blank frame, which becomes the screenshot. It is read from
  Xvfb's own framebuffer file (`-fbdir`), so no screenshot tool is installed in
  any image.

The output is in `test-results/linux-smoke/`: `result.json`,
`app-report.json`, `screenshot.png` and `app.log`. A pass shows the login
screen.

| Flag | Effect |
|---|---|
| `--reuse-export` | Build from the export already in `out-desktop` instead of building it again |
| `--skip-build` | Test what is already in `release/linux*-unpacked/` |

The app runs without `TRACKYOURTIME_HEADLESS`. On X11 a window that was never
shown paints nothing. Xvfb is a virtual display, so the shown window never
reaches a real screen.

Setup, once:

```bash
brew install docker colima
```

```bash
colima start
```

The first run builds the `crossplat-linux-smoke:1` image, which takes a few
minutes. Later runs take about 15 seconds plus the app build.

## pnpm test:desktop:packages

`test:desktop:linux` above runs the **unpacked** app, so it never touches the
packaging: the desktop entry, the icon paths, the AppImage runtime, the declared
dependencies and the install scripts are all untested by it. This command takes
the files a release actually ships — `.AppImage`, `.deb`, `.rpm` — and proves
each one installs and starts.

```bash
pnpm test:desktop:packages                 # every package in release/
pnpm test:desktop:packages --dir <dir>     # e.g. a `gh release download` folder
pnpm test:desktop:packages <file>...       # exactly these
```

The packages are built on Linux only (`node scripts/build-desktop.mjs --channel
linux --package --bundles appimage,deb,rpm`, or the release workflow); on a Mac,
test a release's with `--dir`.

Each kind is installed the way a person installs it, in an image that carries
**only the test harness** — a virtual display, a session bus and Node, and no
desktop runtime library at all:

| Kind | Image | How it is installed |
|---|---|---|
| `.deb` | Debian (`node:24-bookworm-slim`) | `apt-get install ./file.deb`, so `Depends` is really resolved |
| `.rpm` | Fedora 41 | `dnf install ./file.rpm`, so `Requires` is really resolved |
| `.AppImage` | the `linux-smoke` image, which has the desktop libraries an AppImage expects to find | `chmod +x`, then `--appimage-extract` and run the AppDir |

That bareness is the point: a dependency the package forgot to declare fails the
install here instead of being satisfied by accident. WebKitGTK, GTK and dbus are
linked, so a missing one fails at start; the tray's AppIndicator and the idle
time's libXss are **dlopened**, so `ldd` never names them and a missing one
would only lose the tray icon or the idle prompt. All of them are declared by
name (`LINUX_PACKAGE_DEPENDENCIES` in `scripts/lib/desktop-tauri.mjs`).

It then reads the installed `.desktop` file, checks its `Exec` and `Icon`
resolve to files that exist, and hands the program to the same probe
`test:desktop:linux` uses, in the same report mode — so the pass criteria are
identical. Output is `test-results/linux-packages/<kind>-<arch>/`, with
`install.json` beside the usual files.

| Flag | Effect |
|---|---|
| `--dir <dir>` | Look for packages here instead of `release/` |
| `--with-recommends` | Plain `apt install ./x.deb` — weak dependencies allowed. Off by default, because a `Recommends` entry can satisfy a dependency that `Depends` should have declared |
| `--appimage-mode fuse` | Mount the AppImage through FUSE instead of unpacking it. Needs `--device /dev/fuse`, which the runner adds |

Two limits:

- **Only the Docker daemon's own architecture.** A package built for the other
  one is skipped with a notice rather than emulated, because emulating it tests
  qemu rather than the package. The other architecture belongs on a runner of
  that architecture.
- **The package must sit under a path the daemon shares with the host.** colima
  shares the home directory but not `/tmp`, so a `gh release download --dir
  /tmp/...` is invisible inside the container. The runner says so when it
  happens.

### Upgrading an Electron package in place

The deb and rpm keep the Electron packages' name, `trackyourtime`, so
`apt install ./trackyourtime_<v>_amd64.deb` upgrades an Electron install
rather than installing a second app. One trap is handled in the new package:
the Electron package's post-remove script, which dpkg and rpm also run on an
upgrade, removes its `update-alternatives` link for `/usr/bin/trackyourtime`.
The Tauri package's pre-install script (`build/linux/preinstall.sh`) removes
that registration first, so the old script has nothing left to remove and
cannot take the new binary's path with it. This path has not been run against
a real Electron install yet; check it with an old deb before the first Tauri
release.

### What it found in the Electron packages

Against the v0.1.2 arm64 artifacts, all three Electron packages failed, each
for its own reason: the `.deb` on `libgbm.so.1` and the `.rpm` on
`libasound.so.2` (both DT_NEEDED and undeclared), and the AppImage on its
runtime's `DT_NEEDED: libz.so`. The fixes were in the electron-builder config
of the time; the lesson — declare every library by name, and never rely on one
arriving transitively — is what `LINUX_PACKAGE_DEPENDENCIES` follows.

For package QA before tagging, use **Linux Package QA**
(`.github/workflows/linux-package-qa.yml`). It builds and tests all three
packages on native x64 and ARM64 runners. Results and tested packages stay in
Actions artifacts. It does not publish a release or upload to a store:

```bash
gh workflow run linux-package-qa.yml --ref main
```

Do not restart shared Docker services to make room for QA.

## One-time setup: a Windows 11 VM in UTM

This VM and the share serve every project that uses `scripts/crossplat/`.
Set them up once, not once per project.

1. **Get the ISO.** Download Windows 11 for Arm64 from
   <https://www.microsoft.com/software-download/windows11arm64>.
2. **Create the VM.** In UTM, choose **Create a New Virtual Machine** →
   **Virtualize** → **Windows**. Tick **Install drivers and SPICE tools** and
   select the ISO. Give it 8 GB of memory, 4 cores and at least 64 GB of disk.
   Leave **Shared Directory** empty: it uses WebDAV, which refuses files over
   50 MB, and other projects' builds are larger than that.
3. **Install Windows.** Follow UTM's guide, <https://docs.getutm.app/guides/windows/>,
   which also covers accounts. When setup finishes, run the SPICE guest tools
   installer from the mounted CD drive, then restart.
4. **Share `~/VMShare` from the Mac over SMB:**
   1. Run `mkdir -p ~/VMShare`.
   2. Open **System Settings → General → Sharing** and turn on **File Sharing**.
   3. Click ⓘ, add `~/VMShare` under **Shared Folders**, then click **Options…**.
   4. Turn on **Share files and folders using SMB**.
   5. Under **Windows File Sharing**, tick your account and enter its password.
5. **Map the share in Windows.** In File Explorer, open `\\192.168.64.1\VMShare`
   and sign in with your Mac user name and password. Then right-click the
   folder → **Map network drive** → `Z:`, with **Reconnect at sign-in** ticked.
6. **Check it.** Run `pnpm prod:win` on the Mac, then open `Z:\INDEX.txt` in the
   VM. The drop should be listed.

A Linux desktop VM (Ubuntu 24.04 arm64 in UTM) works the same way. Mount the
share with `sudo mount -t cifs //192.168.64.1/VMShare /mnt/vmshare -o user=<you>`
and run the `run.sh` files. That VM is what `pnpm desktop:try-release` drops
for. There is no `prod:linux`, which would build one on the Mac: the Docker
smoke test covers start-up, and the release's own AppImage is the thing worth
clicking.

An AppImage needs FUSE. On Ubuntu 24.04, `sudo apt install libfuse2t64` once;
without it the AppImage exits saying so.

## Other projects

`scripts/crossplat/README.md` lists what another project copies, and how an
Electron app (the probe's `cdp` mode) and a Tauri app (its `report` mode) each
use the same runners and drop folder.


## Isolated iOS simulator QA

Build the current mobile export, then run native WKWebView checks:

```bash
NEXT_PUBLIC_API_URL=https://api.trackyourtime.dev pnpm build:mobile ios
pnpm test:ios:simulator
```

Requires macOS, Xcode with an available iOS simulator runtime, Node 24, installed
workspace dependencies, and `mongod` on PATH. Run one simulator suite at a time.
The runner refuses to boot while another simulator is running.

The runner copies the native project to a temporary directory, removes the real
secure-storage package from SPM and Capacitor registration, and substitutes a
fake store inside a separate app container. A binary-symbol check rejects builds
that still link the real plugin. The QA bridge is compiled only into this
throwaway project; it cannot compile for a physical device. Shipping source and
release credentials stay outside the harness.

The suite checks packaged launch, login layout, native plugin calls, fake-store
and Preferences persistence, lifecycle events, appearance, the iPhone portrait policy, auth-page
navigation, local-server selection, bearer login, timer start/stop and relaunch,
offline queue recovery, and remote session revocation. Signed-in checks use a
fresh local API and MongoDB directory, with email, payments, Redis and background
scheduling disabled. Transport failure is injected inside the QA webview;
physical radio changes and the OS keychain are not tested.

Evidence is written to `test-results/ios-simulator/`: JSON outcomes, screenshots,
build logs, and API request metadata with credential values omitted. The runner
shuts down/deletes its simulator and stops its API/database, including on test
failure. Temporary build files remain available for diagnosis. To rerun checks
without rebuilding, set `IOS_QA_APP` to the isolated app path in `result.json`.
`IOS_QA_OUTPUT` selects another evidence directory. For repeated checks,
`IOS_QA_DEVICE=<udid>` can use a stopped simulator. The default model is iPhone
17; `IOS_QA_DEVICE_NAME="iPad mini (A17 Pro)"` selects iPad layout and landscape
checks. Match the name when supplying an existing UDID. The runner refuses
to overwrite an existing QA app, uninstalls its own app afterward, and shuts
down the reused simulator without deleting it.

If iPad windowing rejects programmatic orientation changes, the runner records
that check as blocked, keeps a nonzero exit status, and continues the independent
app-flow checks. It does not change the shipping windowing policy to force a pass.
An interactive follow-up can use Simulator’s Rotate toolbar to test device
rotation independently. This passed the iPad login landscape layout at 1133×744
on 30 September 2026, without horizontal overflow or captured errors. Keep the
headless blocked result separate from that interactive result.

### Recovering native Simulator input

If computer control returns `noWindowsAvailable` while Simulator screenshots
still work, reset the computer-control session, reacquire Simulator by bundle ID
(`com.apple.iphonesimulator`), choose **Window → Fit Screen**, and obtain a fresh
screenshot before sending coordinate input. This sequence restored native taps
on 30 September 2026. It is a verified recovery, not a root-cause diagnosis or a
patch to the external control service.

The interactive iPhone 17 / iOS 26.5 follow-up passed email entry through actual
software keys, password focus/masked entry, keyboard dismissal and reopening.
Both focused fields stayed visible; viewport height changed from 874 to 539
points and back, with scale 1, no horizontal overflow and no captured errors.
No login was submitted. Evidence is in
`test-results/release-qa/native-2026-09-30/ios-keyboard/` in the primary checkout.
These checks use the isolated QA build, not the signed distribution build.

The iPad follow-up reproduced a focused password field below the visible area
when rotating portrait to landscape with the keyboard open. The iOS-only
`watchKeyboardVisibility` bridge watches focus and viewport resize events,
waits for resizing to settle, and centers an editable field only when occluded.
It ignores pinch zoom and does not subscribe to scroll events. Regression tests
use the observed 316-point viewport and the original field bounds (369–409).
The patched native build kept the field at 138–178 points after rotation and
keyboard reopening. Dismissal restored the full 744-point landscape viewport.
Portrait masked entry, rotation, dismissal and reopening passed with no overflow
or captured errors. Evidence is in
`test-results/release-qa/native-2026-09-30/ipad-keyboard/`; the same patched build
also passed all nine native iPhone checks in `ios-rotation-fix-suite/`.
The XCUITest follow-up below now covers native window resizing and signed-in
Tracker/Reports landscape navigation.

Headless WKWebView checks do not establish iOS software-keyboard behavior,
physical-device performance, or signed distribution-build acceptance. Keep those
release checklist items open until their corresponding checks have run.


## Isolated Android emulator QA

```bash
source scripts/android-env.sh
NEXT_PUBLIC_API_URL=https://api.trackyourtime.dev pnpm build:mobile android
pnpm test:android:emulator
```

The Android runner shares the iOS app-flow checks and uses a temporary native
project with a separate application ID. It removes the secure-storage Gradle
dependency and plugin registration, injects a fake SharedPreferences store, and
rejects an APK containing the original plugin classes. Its JavaScript evaluation
bridge exists only in the temporary debug app. That app permits loopback HTTP
for the disposable API; release network configuration remains unchanged.

Requires the Android SDK, its command-line tools, the JDK, `mongod`, and the
`Medium_Phone_API_35` AVD (override with `ANDROID_QA_AVD`). The runner refuses to
start with any Android device already connected, then starts one headless,
read-only emulator without audio or saved snapshots. It uses `adb reverse` for
the local API, removes its own app, stops its own backend, and terminates its
emulator afterward. It does not stop another emulator or the shared ADB server.

Evidence goes to `test-results/android-emulator/`. `ANDROID_QA_OUTPUT` overrides
the destination; `ANDROID_QA_APK` reruns an existing isolated APK without building.
These checks cover the native WebView and app flows, not Android Keystore,
physical radio behavior, or the APK Google Play signs and distributes. Android
relaunch first backgrounds the app so pending asynchronous Preferences writes
can flush; killing the process in the middle of a write is a separate durability
case and is not covered by the normal-relaunch assertion.

## Native iPad XCUITest QA

`pnpm test:ios:ui` builds an isolated simulator app and a standalone XCUITest
runner, starts a disposable local API/database and fake account, then tests:

- Native server selection and email/password login.
- Landscape layout, Reports navigation, timer start/stop and cold relaunch.
- Native iPad window-handle dragging, changed WebView viewport dimensions, and
  a running timer that remains usable after resizing, followed by expansion.
  Both stopped mobile entries must also exist on the local API.

First export the current client with
`NEXT_PUBLIC_API_URL=https://api.trackyourtime.dev pnpm build:mobile ios`.
Requires Xcode with an iPadOS 26 simulator runtime, Node, project dependencies
and `mongod` on PATH. Run one simulator suite at a time. The default runner
creates and deletes its own iPad mini. Reusing an iPad is deliberately unsupported:
iPadOS retains window geometry even after uninstalling an app.
`IOS_UI_DEVICE_NAME` chooses another installed iPad type. `IOS_UI_OUTPUT` chooses
an empty evidence directory; by default each run has a timestamped directory
under `test-results/ios-xcuitest/`.

The shipping Xcode project is never edited. The temporary app excludes the real
secure-storage package and uses the existing fake UserDefaults plugin. The UI
runner is simulator-only and uses ad-hoc signing without a developer identity.
A simulator-only accessibility element exposes read-only DOM geometry, layout
errors and timer state. XCUITest performs every tap, keystroke, rotation and
drag; the diagnostics do not click elements or alter layout. Screenshot, state
and accessibility attachments are retained in `UIQA.xcresult`, alongside the
Xcode log and a JSON summary. An unchanged viewport, skipped test or nonzero
Xcode exit cannot count as a pass. Device, QA app and local backend cleanup runs
on success or failure.

These checks establish native simulator UI behavior, not real secure-storage,
physical radio behavior, or signed TestFlight/Play-build acceptance. Window
resizing requires a simulator windowing mode that allows it; a failed gesture
is recorded as a failure, not silently replaced with CSS resizing.

The 1 October 2026 iPad mini / iOS 26.5 run passed both scenarios with no skips.
Verified viewport sizes were 1133×744 (landscape), 384×464 (floating window), and
375×744 (expanded vertically). Both timer records persisted with `source=mobile`
and non-null end times. Results and exported screenshots are retained at
`test-results/release-qa/ipad-xcuitest-2026-10-01/run-5/` in the primary checkout.
