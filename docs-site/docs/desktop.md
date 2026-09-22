---
title: Desktop app
sidebar_label: Desktop app
description: Install the Track Your Time desktop app on macOS, Windows or Linux, sign in to the hosted service or your own server, and learn how each version updates.
---

# Desktop app

The desktop app puts the timer in the macOS menu bar or the Windows and Linux
system tray, and gives it a keyboard shortcut that works in every app. It is
the web app in its own window, so every screen is there. It keeps tracking
without a connection and sends your changes when the connection comes back.

**No version is released yet.** There is nothing to download today, and none
of the stores lists the app. You can build it from source, as described
[below](#build-it-from-source). This page describes the channels as they will
work once a release is published.

## Where to get it

| Version | Where from | How it updates |
| --- | --- | --- |
| macOS dmg (Apple silicon and Intel) | GitHub Releases | Updates itself |
| Windows installer | GitHub Releases | Updates itself |
| Linux AppImage | GitHub Releases | Updates itself |
| Homebrew cask | A Homebrew tap | Updates itself. `brew upgrade` leaves it alone unless you pass `--greedy` |
| Linux deb and rpm | GitHub Releases | Does not update itself. Install the new package by hand |
| Mac App Store | The store | The store updates it |
| Microsoft Store | The store | The store updates it |
| Snap Store | The store | snapd updates it |
| Flathub | Flathub | Flatpak updates it |

None of these is available yet. Settings → Desktop → Updates shows which kind
of version you have and why it does or does not update itself.

## Updates

A version that updates itself checks GitHub Releases 30 seconds after it starts
and then every 6 hours. It only sees releases that have been published, never
drafts or prereleases. When it finds a newer version, it downloads it in the
background.

**The app never restarts on its own.** A downloaded update installs the next
time you quit Track Your Time. To install it now, choose **Restart to update**
in Settings → Desktop or in the menu bar or tray menu. Unsent changes are kept
through the restart, as they are through any quit.

What you see in Settings → Desktop → Updates:

- the version you run, and when the app last checked
- **Check for updates**, which checks now
- **Restart to update**, once a download is ready

To stop a copy from updating itself, for example on a managed computer, start
it with the environment variable `TRACKYOURTIME_DISABLE_UPDATES=1`.

A build you make yourself has no update feed, so it never updates itself.

## Sign in

- **With your password**, on the sign-in screen.
- **With your browser**, if your account uses two-factor authentication or
  Google. The app shows a code, your browser opens, and you approve the code
  there while you are signed in.

The app keeps its session in the operating system's credential store: the
Keychain on macOS, DPAPI on Windows, and GNOME Keyring or KWallet on Linux. On
Linux without a keyring, the app keeps the session in memory only and asks you
to sign in again after a restart. Settings → Devices says when that happens.

### Your own server

On the sign-in screen, choose **Change server** and enter your server's
address. The app checks that the server answers before it saves your choice.

Your server must trust the desktop app's origin, `app://-`. Either set
`TRUST_STORE_APPS=true`, which the self-hosting compose file sets by default,
or add `app://-` to `TRUSTED_ORIGINS`. Without it, sign-in fails and the app
names the setting to change.

## Settings → Desktop

These settings belong to the computer, not to your account.

- **Open at login.** On macOS 13 or later, the system may ask you to approve
  it in System Settings → General → Login Items. This setting is not available
  in the Microsoft Store or Flatpak versions.
- **Show the timer in the menu bar or system tray.** The menu stops the running
  timer, continues one of your last five entries, or starts a new one.
- **Keep running when the window is closed** (Windows and Linux). On macOS,
  closing the window always keeps the app running.
- **Dock or taskbar badge while a timer runs** (macOS and Windows).
- **Keyboard shortcuts** for four actions: start or stop the timer, a new
  timer, show or hide the window, and the command palette. Only the first has
  a shortcut from the start: ⌥⇧⌘Space on macOS, Ctrl+Alt+Shift+Space on
  Windows and Linux. If another app already uses a shortcut, Settings says so.

## Activity suggestions

The desktop app can record which app is in front and suggest entries for the
time you did not track. Capture is off until you turn it on in **Settings →
Desktop → Activity capture**. It asks for no system permission.

What it records, and where:

- The name of the app in front, when it came to the front and when it left.
  A stretch ends when you are idle or the screen locks.
- Window titles, only on Windows and Linux, and only when you switch on
  **Include window titles**. Turning them off deletes the titles already
  stored. The Mac app records app names only.
- Everything stays in the app's own folder on your computer (`activity/` in
  the app's data folder). Nothing is sent until you add an entry, and that
  entry holds only what you put in it.
- Activity is deleted after 14 days by default. You can set 1 to 90 days.
- **Never record** takes an app from your recent apps or a pattern such as
  `com.example.*`. Adding one deletes what is already recorded for that app.
  The app never records itself, the lock screen or the screen saver.
- **Delete all activity now** removes the recorded activity. Signing out
  removes the activity and the rules.

The **Activity** page lists the untracked stretches for a day. **Add** files a
stretch as an entry, **Edit and add** lets you change it first, and
**Dismiss** hides it. **Always file … under** saves a project, task, tags and
description for an app. New suggestions where that app is the busiest start
with them. Rules stay on this computer.

How each system reads the app in front:

| System | How | Not available |
| --- | --- | --- |
| macOS | `lsappinfo`, which ships with macOS | Mac App Store version |
| Windows | A PowerShell process that the app starts | Microsoft Store version; PCs where policy puts PowerShell in Constrained Language Mode |
| Linux | `xprop` on an X11 session | Wayland sessions, Snap, Flatpak, or when `xprop` is not installed |

## Build it from source

You need Node.js 24 and pnpm. Node 26 is known to leave Electron's download
incomplete.

```bash
git clone https://github.com/trebeljahr/trackyourtime.git
cd trackyourtime
pnpm install
NEXT_PUBLIC_API_URL=https://api.trackyourtime.dev pnpm electron:build
```

`NEXT_PUBLIC_API_URL` is the server the app connects to first. You can pick
another one on the sign-in screen later. The build writes the installers for
the system you build on into `release/`: a dmg and a zip on macOS, an installer
on Windows, and an AppImage, deb, rpm, tar.gz and snap on Linux. The rpm
needs `rpmbuild` and the snap needs `snapcraft`.

A build you make yourself is not signed, and on macOS and Windows its file
names end in `-unsigned`. It does not update itself.

## Limits

- On Linux under Wayland, global shortcuts do not work outside XWayland.
- GNOME shows tray icons only with the AppIndicator extension. The app cannot
  tell whether the icon appeared, so on Linux closing the window quits the app
  unless you turn on **Keep running when the window is closed**.
- On Linux the tray shows no running time, because AppIndicator has no
  tooltip. The icon changes while a timer runs.
- Activity capture does not work on Wayland, in the store versions, or in the
  Snap and Flatpak versions. The Activity page is hidden there.
- The Mac app does not record window titles, because macOS gives them only to
  apps with the Screen Recording permission.
