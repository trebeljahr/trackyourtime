# Builds the desktop app for Linux on a machine that cannot (a Mac), for
# `pnpm test:desktop:linux` (scripts/desktop-linux-smoke.mjs). The same build
# dependencies the release runners install (desktop-release.yml): WebKitGTK
# 4.1, GTK, the tray's AppIndicator, dbus. Built for the Docker daemon's own
# architecture; the binary is then smoke-tested in crossplat's linux-smoke
# image, never on the host.
FROM rust:1-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libdbus-1-dev \
    pkg-config patchelf file \
  && rm -rf /var/lib/apt/lists/*
