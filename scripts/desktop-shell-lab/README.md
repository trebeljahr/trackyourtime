# Desktop shell interaction study

Build an offline, self-contained HTML study:

```sh
node scripts/desktop-shell-lab.mjs [output-directory]
node scripts/desktop-shell-lab/verify.mjs [same-output-directory]
```

Default output: `test-results/desktop-shell-lab/index.html`. Open the file in a
browser; no server or account is needed. Verification uses the repository's
installed Playwright Chromium and closes its own browser in `finally`.

The build bundles the real tray model and window policy. Device defaults are
read from `defaultDesktopSettings` at build time. All entries are synthetic;
no native tray, global shortcut, activity capture, keychain or network is used.

The compact timer is an interaction proposal, not a production app window.
Desktop chrome is an illustration, not a native screenshot. The shortcut button
dispatches an action in the page; it does not verify OS registration. Login and
exit controls exercise the policy in a browser, not real process lifecycle.

Profiles distinguish Windows, KDE, GNOME with/without an indicator, an Xfce or
Cinnamon setup with a host, and a macOS comparison. Linux profiles deliberately
share conservative defaults. Distro names do not establish tray availability.

Research, support priorities, native acceptance matrix, and archived captures
live in the project vault's 2026-10-23 desktop-shell exploration bundle.
