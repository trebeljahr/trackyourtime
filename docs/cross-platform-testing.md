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
