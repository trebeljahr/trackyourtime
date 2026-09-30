# Trying the desktop app on Windows and Linux

Three commands, built on the project-agnostic tools in `scripts/crossplat/`:

```bash
pnpm prod:win                       # Windows arm64 build against api.trackyourtime.dev, dropped for a UTM VM
pnpm desktop:try-release 0.1.2      # the file a release published, downloaded and dropped for a VM
pnpm test:desktop:linux             # Linux build, started in Docker under Xvfb: pass/fail + screenshot
```

`prod:win` and `desktop:try-release` are for a person, like `prod:desktop`:
they put an app in front of you in a VM and you run it by hand.
`test:desktop:linux` is safe for agents and CI, because nothing opens on the
host's screen.

The first two answer different questions. `prod:win` cross-builds an **unpacked**
app on this Mac, which tests the code; `desktop:try-release` downloads the
**installer or AppImage a user downloads**, which tests what the release
workflow actually produced — the packaging, the launcher, the file's own
integrity. Use it before publishing a draft release.

`prod:win` and `test:desktop:linux` need Node 24, like every desktop build
(`nvm use 24`). `desktop:try-release` builds nothing and needs only `gh`.

## pnpm prod:win

1. The command builds the unpacked Windows arm64 app on the Mac. electron-builder
   cross-builds it with no Wine.
2. It copies the build to `~/VMShare/trackyourtime/windows-arm64/`, next to
   `run.cmd`.
3. In the Windows VM, open the share and double-click
   `trackyourtime\windows-arm64\run.cmd`. The launcher copies the build to
   `%LOCALAPPDATA%\crossplat\` and starts it.

Quit the app in the VM before the next drop. Otherwise the launcher cannot
replace the files it is still running.

The build is arm64 to match a Windows VM on Apple Silicon. Most Windows users
have x64 machines; the release workflow builds x64 on a real Windows runner.

Windows shows a SmartScreen warning ("Windows protected your PC") because the
build is unsigned. Click **More info**, then **Run anyway**.

To start the VM automatically after each drop, set the VM's name in your shell
profile. This opens UTM's window.

```bash
export CROSSPLAT_UTM_VM="Windows 11"
```

### Against a local API instead

The VM reaches the Mac at `192.168.64.1` on UTM's default Shared Network. The
dev server listens on every interface and trusts `app://-`. So pin the API
port, then bake that address into the build:

```bash
API_PORT=51590 PORT=33920 pnpm run dev
```

```bash
NEXT_PUBLIC_API_URL=http://192.168.64.1:51590 node scripts/build-desktop.mjs --package --win --arm64 --dir && node scripts/crossplat/vm-drop.mjs --project trackyourtime --platform windows-arm64 --source release/win-arm64-unpacked --launch "Track Your Time.exe" --note "local API"
```

## pnpm desktop:try-release

```bash
pnpm desktop:try-release 0.1.2                  # Linux arm64 AppImage (the default)
pnpm desktop:try-release v0.1.2 linux-x64
pnpm desktop:try-release 0.1.2 --start-vm "Ubuntu 24.04"
```

1. It asks `gh` for that release — a **draft** counts, which is where every
   release sits until a person publishes it (CLAUDE.md → desktop release).
2. It downloads the one asset that platform can start by itself, and the
   release's `SHA256SUMS.txt`, and refuses the drop if the sha256 does not
   match. A 120 MB AppImage that arrived short should fail here, not in the VM.
3. It hands the file to `scripts/crossplat/vm-drop.mjs`, which writes
   `~/VMShare/trackyourtime/<platform>/` with the asset, a `run.sh` (or
   `run.cmd`) and a `DROP.json` noting the tag.
4. In the VM, double-click the launcher. It copies the file to the guest's own
   disk, marks it executable and starts it.

The version may be written `0.1.2` or `v0.1.2`. No VM is started unless
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
| `linux-x64` | `TrackYourTime-<version>-linux-x86_64.AppImage` (electron-builder writes the machine's own arch string) |
| `windows-x64`, `windows-arm64` | `TrackYourTime-Setup-<version>.exe` — one installer carries both |

The deb, rpm and tar.gz on a release are installs and archives, not files a
launcher can execute, so the command does not offer them. Fetch one by hand
with `gh release download <tag> --repo trebeljahr/trackyourtime --pattern
"*.deb"`.

### Windows asks for a file that does not exist yet

```
pnpm desktop:try-release 0.1.2 windows-arm64
```

```
desktop:try-release — v0.1.2 publishes no Windows asset (TrackYourTime-Setup-0.1.2.exe
  is not there), so there is nothing a Windows VM can install.
```

That is not a bug in the command. Windows signing is not set up: with no
certificate (`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`, or Azure Trusted
Signing) the release workflow builds Windows as `-unsigned`, and it never
attaches an `-unsigned` file to a release (docs/deploy.md → "Desktop release",
and → winget, which waits on the same installer). So until signing lands,
`pnpm prod:win` is the way to try the app on Windows, and the command says so
and exits non-zero.

## pnpm test:desktop:linux

The command builds the unpacked Linux app for the Docker daemon's architecture
(arm64 on this Mac, x64 on an x64 runner). The build points at a closed
loopback port, `127.0.0.1:59999`, so no server is needed.

It then starts the app in a container, under Xvfb, and checks four things:

- a page at `app://-` appears;
- the page throws no uncaught error;
- a screenshot succeeds;
- the app is still running 5 seconds later.

The output is in `test-results/linux-smoke/`: `result.json`, `screenshot.png`
and `app.log`. A pass shows the login screen with two refused requests in the
console, which are expected with no server.

| Flag | Effect |
|---|---|
| `--reuse-export` | Package the export already in `out-desktop` instead of building it again |
| `--skip-build` | Test what is already in `release/` |

The app runs without `TRACKYOURTIME_HEADLESS`. On X11 a window that was never
shown gives CDP no frames, and the screenshot waits forever. Xvfb is a virtual
display, so the shown window never reaches a real screen.

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
dependencies and the install scriptlets are all untested by it. This command
takes the files a release actually ships — `.AppImage`, `.deb`, `.rpm` — and
proves each one installs and starts.

```bash
pnpm test:desktop:packages                 # every package in release/
pnpm test:desktop:packages --dir <dir>     # e.g. a `gh release download` folder
pnpm test:desktop:packages <file>...       # exactly these
```

Each kind is installed the way a person installs it, in an image that carries
**only the test harness** — a virtual display, a session bus, Node and
playwright-core, and no Electron runtime library at all:

| Kind | Image | How it is installed |
|---|---|---|
| `.deb` | Debian (`node:24-bookworm-slim`) | `apt-get install ./file.deb`, so `Depends` is really resolved |
| `.rpm` | Fedora 41 | `dnf install ./file.rpm`, so `Requires` is really resolved |
| `.AppImage` | the `linux-smoke` image, which has the desktop libraries an AppImage expects to find | `chmod +x`, then `--appimage-extract` and run the AppDir |

That bareness is the point: a dependency the package forgot to declare fails the
install here instead of being satisfied by accident.

It then reads the installed `.desktop` file, checks its `Exec` and `Icon`
resolve to files that exist, and hands the program to the same probe
`test:desktop:linux` uses — so the pass criteria are identical: a page at
`app://-`, no uncaught page error, a screenshot, and still running after the
settle time. Output is `test-results/linux-packages/<kind>-<arch>/`, with
`install.json` beside the usual `result.json`, `screenshot.png` and `app.log`.

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

Like `test:desktop:linux`, the app runs without `TRACKYOURTIME_HEADLESS`, for
the same reason: on X11 a never-shown window gives CDP no frames.

### What it found

Run against the v0.1.2 arm64 artifacts, all three failed, each for its own
reason. The `.deb` and `.rpm` are fixed in `electron-builder.config.mjs`
(`deb.depends`, `rpm.depends`). The AppImage fix selects the static runtime
with `toolsets.appimage: "1.0.3"`, instead of the legacy runtime below.

| Artifact | Verdict | Cause |
|---|---|---|
| `trackyourtime_0.1.2_arm64.deb` | failed | `libgbm.so.1: cannot open shared object file` — `libgbm1` and `libasound2` are DT_NEEDED and were in neither `Depends` nor electron-builder's default list |
| `trackyourtime-0.1.2.aarch64.rpm` | failed | `libasound.so.2` — `alsa-lib` undeclared. `mesa-libgbm` only arrived because `gtk3` happens to pull it, and `libsecret` (dlopened by `safeStorage`, so invisible to `ldd`) was missing entirely |
| `TrackYourTime-0.1.2-linux-arm64.AppImage` | failed | The AppImage **runtime** has `DT_NEEDED: libz.so` — the unversioned symlink, which ships in `zlib1g-dev` and is not on a user's machine. The payload is sound: with that symlink present the app extracts and reaches `app://-` |

`depends` **replaces** electron-builder's defaults rather than adding to them,
so the config repeats the whole list. Dropping one is silent until an install
fails.

On 30 September 2026, the original v0.1.2 ARM64 packages failed again after
their checksums were verified. The rebuilt AppImage and deb passed clean
install/startup tests with the fixes. See [release readiness](release-readiness.md)
for the full results and remaining platform checks. Release CI now runs these
package tests on both Linux architectures before creating the draft.

For package QA before tagging, use **Linux Package QA**
(`.github/workflows/linux-package-qa.yml`) after the workflow reaches main.
It builds and tests all three packages on native x64 and ARM64 runners.
Results and tested packages stay in Actions artifacts. It does not publish a
release or upload to a store. After authorization to push and dispatch:

```bash
gh workflow run linux-package-qa.yml --ref main
```

The local RPM rebuild exposed a separate resource failure: Colima's kernel
killed `rpmbuild` during multithreaded xz compression in its 2 GB VM. The RPM
configuration now uses gzip to reduce memory use, at the cost of a larger
archive. Native CI run [36651056513](https://github.com/trebeljahr/trackyourtime/actions/runs/36651056513) passed RPM build, installation and startup on x64 and ARM64, alongside AppImage and deb.
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
   50 MB, and the app's executable is about 200 MB.
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
Electron app and a Tauri app each feed the same drop folder.


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
Interactive window resizing and signed-in iPad landscape remain unverified.

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
