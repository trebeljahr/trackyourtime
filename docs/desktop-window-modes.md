# Desktop window modes

The full app and compact timer use one `BrowserWindow`, renderer, sync connection
and offline queue. Compact mode hides the normal shell with `display: none` and
`inert`; it does not unmount the current screen or discard its form state. The
existing bridge publisher draws the compact timer and executes its commands
through the same `useEntryMutations` instance as the tray.

## Entry points

- The app header opens the compact timer.
- The signed-in tray menu exposes both the full app and compact timer. Windows
  retains left-click window recovery and right-click menu access. Linux uses the
  desktop's StatusNotifierItem/AppIndicator menu host.
- Packaged Windows builds add full-app and compact-timer taskbar tasks. They
  launch the existing executable with `--full-window` or `--compact-timer`;
  single-instance handling forwards those requests to the running window.
- GNOME sessions identified by `XDG_CURRENT_DESKTOP` default to compact after
  sign-in, unless a saved mode overrides that default. No tray extension is
  required. Other desktops default to full mode, with compact available.
- New-entry, editing, Settings, prompt and command-palette actions expand to the
  full app. Compact Start opens the existing composer; recent work starts
  directly. Stop and Continue never require expanding the window.

Unknown Linux desktops retain the full-app fallback. Desktop identification
does not imply that an indicator host exists. Linux close-to-tray remains off
by default; hidden login startup also requires explicit close-to-tray opt-in.
Revealing a Windows/Linux window restores its taskbar visibility.

## Window state and IPC

`window-state.json` retains the original `bounds`, `maximized` and `fullscreen`
fields for the full app, plus `compactBounds`, preferred `mode` and
`alwaysOnTop`. Each mode has separate minimum/default dimensions and restores
only title-area coordinates on a connected display. Entering compact exits
fullscreen and maximization without replacing the saved full-app bounds.

`desktop.window` in the shared bridge provides `getState`, `setMode`,
`setAlwaysOnTop` and `onChanged`. The property is optional for older preloads.
Main validates every incoming mode/boolean through the trusted IPC handler.
Window transitions are serialized so sign-out can override an in-flight mode
change. The renderer ignores a stale initial snapshot after receiving an event.

Authentication screens always use the full, unpinned window. A saved compact
preference is applied only after the signed-in publisher reports authentication;
sign-out preserves that preference for the next sign-in. Pinning is off by
default and applies only in signed-in compact mode. A currently open modal
editor keeps the full view so its portal/focus trap remains usable.

## Validation

`window-presentation.test.ts`, `window-policy.test.ts` and `taskbar-model.test.ts`
exercise persistence, visibility policy and Windows task arguments without native
side effects. The client tests cover compact commands, workspace identity, busy
state, snapshot races and composer focus after the full view leaves `inert`.

`e2e/desktop/compact.spec.ts` runs the real Electron main/preload/export against
the isolated API/database harness. It covers shared timer commands, remote
updates, offline replay, independent bounds, pin preference, relaunch,
sign-out/full auth sizing and theme sync. It accounts for Linux's nonpersistent
credential fallback. Rendering captures are macOS-only because a never-shown
X11 window has no screenshot frames.

Headless runs never pin, show or focus a native window and never install taskbar
tasks or a native tray. These checks do not certify Windows Explorer menus,
Linux indicator hosts, compositor placement or always-on-top behavior. Native
acceptance evidence and captures belong in the project QA vault.
