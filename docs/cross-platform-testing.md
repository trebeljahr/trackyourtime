# Trying the desktop app on Windows and Linux

Two commands, built on the project-agnostic tools in `scripts/crossplat/`:

```bash
pnpm prod:win            # Windows arm64 build against api.trackyourtime.dev, dropped for a UTM VM
pnpm test:desktop:linux  # Linux build, started in Docker under Xvfb: pass/fail + screenshot
```

`prod:win` is for a person, like `prod:desktop`: it points the app at the live
API and you run it by hand inside a VM. `test:desktop:linux` is safe for
agents and CI, because nothing opens on the host's screen.

Both need Node 24, like every desktop build (`nvm use 24`).

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
and run the `run.sh` files. No `prod:linux` script exists yet; the Docker smoke
test covers start-up.

## Other projects

`scripts/crossplat/README.md` lists what another project copies, and how an
Electron app and a Tauri app each feed the same drop folder.
