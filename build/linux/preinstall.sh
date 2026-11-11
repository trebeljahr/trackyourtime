#!/bin/sh
# Pre-install script of the Track Your Time deb and rpm (Tauri builds;
# scripts/lib/desktop-tauri.mjs → preInstallScript).
#
# Track Your Time 0.3.0 and earlier were Electron packages of the same name.
# Their post-install script registered /usr/bin/trackyourtime as an
# update-alternatives link into "/opt/Track Your Time", and their post-remove
# script — which dpkg and rpm also run on an UPGRADE, after this package's files
# are in place — removes that alternative again. Removing the registration here,
# before the new /usr/bin/trackyourtime is unpacked, leaves the old script
# nothing to remove, so it cannot take the new binary's path with it.
#
# Harmless on a fresh install, and on every upgrade after the first.
old='/opt/Track Your Time/trackyourtime'
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove trackyourtime "$old" >/dev/null 2>&1 || true
fi
if [ -L /usr/bin/trackyourtime ]; then
  case "$(readlink /usr/bin/trackyourtime)" in
    "$old" | /etc/alternatives/trackyourtime) rm -f /usr/bin/trackyourtime ;;
  esac
fi
exit 0
