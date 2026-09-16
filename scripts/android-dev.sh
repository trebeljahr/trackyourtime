#!/usr/bin/env bash
#
# One-command Android dev loop with live reload.
#
# What this does:
#   1. Source scripts/android-env.sh so JAVA_HOME / ANDROID_HOME are set.
#   2. Boot the emulator if nothing is attached (or use attached device).
#   3. Start Next.js dev server on 0.0.0.0 so the emulator can reach it.
#   4. cap sync with CAP_DEV_URL — capacitor.config.ts injects server.url
#      when that env var is set, making the WebView load from the Next
#      dev server instead of bundled assets.
#   5. cap run android — installs the APK and launches.
#
# Edits to packages/client/src hot-reload on the device in ~500ms.
#
# This script starts the Next dev server and points the WebView at it. It does
# NOT start the API — run that separately, and tell this script where it is:
#
#   API_PORT=51590 PORT=33920 pnpm run dev     # in another terminal
#   API_PORT=51590 pnpm dev:android
#
# NEXT_PUBLIC_API_URL is read by the Next dev server at start and baked into
# the fallback bundle, so a wrong API_PORT here is a phone that loads and then
# fails every request. It is exported explicitly rather than left to whatever
# happens to be in the environment, and it is pointed at the SAME host the
# WebView loads from: from inside the emulator "localhost" is the emulator and
# not the Mac, so an API on the Mac is 10.0.2.2 (the emulator's NAT alias for
# the host), and on a real device it is the Mac's LAN IP.
#
# Under live reload the document origin is http://$DEV_HOST:$NEXT_PORT, not
# https://localhost — so this exercises neither the app's real origin nor its
# place in the server's trust list. Verify auth changes against
# `pnpm build:mobile`, never against this.
#
# Env overrides:
#   AVD=<name>       which AVD to boot (default: Medium_Phone_API_35)
#   NEXT_PORT=<n>    Next.js dev port (default: 51740)
#   API_PORT=<n>     port the API is already listening on (default: 5159)
#   NEXT_PUBLIC_API_URL  full API origin override, wins over API_PORT
#   LAN_IP=<ip>      host the device should reach the Mac at (default:
#                    10.0.2.2, the emulator alias). Required for a real device.
#   CAP_DEV_URL=<url> full WebView dev URL override, e.g.
#                     https://<slug>.local.<your-domain>/
#   ANDROID_HEADLESS=1  boot the emulator with -no-window -no-audio (agent
#                     runs; screenshot with `adb exec-out screencap -p`), so no
#                     emulator window appears or takes focus

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/android-env.sh"

AVD_NAME="${AVD:-Medium_Phone_API_35}"
# Not 7130: that is `pnpm dev:desktop`'s Electron dev port, and this script used
# to take it by force. 51730 is scripts/ios-dev.sh's. Nothing else claims 51740.
NEXT_PORT="${NEXT_PORT:-51740}"
API_PORT="${API_PORT:-5159}"

# Android emulator NAT reserves 10.0.2.2 as "host loopback".
# For a real device over Wi-Fi, pass LAN_IP=<your-mac-ip>.
DEV_HOST="${LAN_IP:-10.0.2.2}"

# The device has to reach the API at the same host it reaches the dev server:
# inside the emulator "localhost" is the emulator itself.
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://$DEV_HOST:$API_PORT}"

# Next 16 refuses cross-origin requests for /_next dev resources, and to the
# dev server a WebView loading http://10.0.2.2:$NEXT_PORT is a foreign origin.
# Without this the document is served, every chunk is blocked, and the app sits
# on a splash that `launchAutoHide: false` never hides — which reads as a
# broken build rather than a blocked request. next.config.ts already merges
# NEXT_DEV_ORIGINS into allowedDevOrigins, so nothing else has to change.
export NEXT_DEV_ORIGINS="${NEXT_DEV_ORIGINS:+$NEXT_DEV_ORIGINS,}$DEV_HOST"

NEXT_PID=""

local_dev_url() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    try {
      const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
      const slug = manifest?.localDev?.slug;
      const configuredDomain = manifest?.localDev?.domain;
      const projectDomain = String(manifest?.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const labels = projectDomain.split(".").filter(Boolean);
      const baseDomain = labels.length > 2 ? labels.slice(-2).join(".") : projectDomain;
      const localDevDomain = configuredDomain || (baseDomain ? `local.${baseDomain}` : "local.example.com");
      if (slug) process.stdout.write(`https://${slug}.${localDevDomain}/`);
    } catch {}
  ' "$REPO/.hatchkit.json"
}

cleanup() {
  echo ""
  echo "Stopping Next.js dev server"
  # Only the process this script started. Clearing the port instead would also
  # take out whatever a colleague, another agent or another worktree had on it.
  if [ -n "$NEXT_PID" ]; then
    kill -TERM "$NEXT_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "   (emulator/phone left running — next dev:android is instant)"
}
trap cleanup EXIT INT TERM

# ── ADB sanity ────────────────────────────────────────────
# `adb start-server` is a no-op when one is already up. It is deliberately NOT
# preceded by a server teardown any more: the adb server is one shared daemon
# for the whole machine, so ending it disconnects every other person's and
# every other agent's device session — and the Capacitor retry race it was
# meant to dodge is far cheaper than that.
adb start-server > /dev/null 2>&1 || true

if lsof -ti:"$NEXT_PORT" > /dev/null 2>&1; then
  echo "Port $NEXT_PORT is already in use — not taking it, it may not be mine."
  echo "  Who has it:  lsof -nP -iTCP:$NEXT_PORT -sTCP:LISTEN"
  echo "  Or pick another:  NEXT_PORT=<n> pnpm dev:android"
  exit 1
fi

if ! curl -s -o /dev/null --max-time 2 "http://localhost:$API_PORT/api/health"; then
  echo "Warning: nothing answering on localhost:$API_PORT — the app will load"
  echo "  and then fail every request. Start the API with:"
  echo "    API_PORT=$API_PORT PORT=33920 pnpm run dev"
  echo ""
fi

# Live reload makes the document origin the dev server's, not the app's own, so
# the API has to trust THAT origin too or every request fails CORS while the
# shell itself looks fine. scripts/dev.mjs trusts this script's default; any
# other port or a physical device needs saying so.
if [ "$DEV_HOST:$NEXT_PORT" != "10.0.2.2:51740" ]; then
  echo "Note: the WebView's origin will be http://$DEV_HOST:$NEXT_PORT, which is"
  echo "  not the one scripts/dev.mjs trusts by default. Start the API with:"
  echo "    TRUSTED_ORIGINS=http://$DEV_HOST:$NEXT_PORT API_PORT=$API_PORT pnpm run dev"
  echo ""
fi

# ── Device selection ──────────────────────────────────────
ATTACHED_DEVICES=$(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')
if [ -n "$ATTACHED_DEVICES" ]; then
  echo "Using attached device(s):"
  echo "$ATTACHED_DEVICES" | sed 's/^/   /'
  if echo "$ATTACHED_DEVICES" | grep -qvE '^emulator-'; then
    if [ -z "${CAP_DEV_URL:-}" ] && [ "$DEV_HOST" = "10.0.2.2" ]; then
      TAILSCALE_DEV_URL="$(local_dev_url)"
      if [ -n "$TAILSCALE_DEV_URL" ]; then
        CAP_DEV_URL="$TAILSCALE_DEV_URL"
        echo ""
        echo "Physical device detected — using hatchkit Tailscale dev URL:"
        echo "  $CAP_DEV_URL"
      else
        echo ""
        echo "Physical device detected but DEV_HOST=10.0.2.2 (emulator-only)."
        echo "Re-run with your Mac's LAN IP:"
        echo "  LAN_IP=\$(ipconfig getifaddr en0) pnpm dev:android"
        echo "Or set CAP_DEV_URL to a reachable HTTPS dev URL."
        exit 1
      fi
    fi
  fi
elif adb devices | awk 'NR>1 && $2 == "unauthorized" { found=1 } END { exit !found }'; then
  echo "Phone shows 'unauthorized' in adb devices."
  echo "Tap 'Allow' on the USB debugging prompt on the phone."
  exit 1
else
  echo "No device attached — booting emulator: $AVD_NAME"
  EMULATOR_WINDOW_FLAGS=()
  if [ "${ANDROID_HEADLESS:-}" = "1" ]; then
    EMULATOR_WINDOW_FLAGS=(-no-window -no-audio)
    echo "   headless (ANDROID_HEADLESS=1)"
  fi
  nohup emulator -avd "$AVD_NAME" \
      ${EMULATOR_WINDOW_FLAGS[@]+"${EMULATOR_WINDOW_FLAGS[@]}"} \
      -no-boot-anim \
      -memory 2048 \
      -gpu host \
      -netdelay none -netspeed full \
    > /tmp/starter-emulator.log 2>&1 &
  disown
  echo "   waiting for adb..."
  adb wait-for-device
  echo "   waiting for Android boot..."
  BOOT_TIMEOUT=120
  SECS=0
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 1
    SECS=$((SECS + 1))
    if [ $SECS -ge $BOOT_TIMEOUT ]; then
      echo "Emulator didn't finish booting in ${BOOT_TIMEOUT}s."
      echo "Log: /tmp/starter-emulator.log"
      exit 1
    fi
  done
  echo "Emulator ready"
fi

# ── Next.js dev server ────────────────────────────────────
CAP_DEV_URL="${CAP_DEV_URL:-http://$DEV_HOST:$NEXT_PORT}"
echo "Starting Next.js dev server at $CAP_DEV_URL (API: $NEXT_PUBLIC_API_URL)"
(cd "$REPO/packages/client" && npx next dev --hostname 0.0.0.0 --port "$NEXT_PORT") &
NEXT_PID=$!

echo "   waiting for Next.js to answer..."
READY_TIMEOUT=60
SECS=0
until curl -s -o /dev/null "http://localhost:$NEXT_PORT"; do
  sleep 0.5
  SECS=$((SECS + 1))
  if [ $SECS -ge $((READY_TIMEOUT * 2)) ]; then
    echo "Next.js didn't start in ${READY_TIMEOUT}s."
    exit 1
  fi
done
echo "Next.js ready"

# ── Fallback bundle ───────────────────────────────────────
# What the WebView falls back to when the dev server is not answering. Built
# against the same API origin, so the fallback is not quietly a different app.
# The mobile export lives in out-mobile/, never the shared out/ — see
# scripts/build-mobile.mjs for why.
if [ ! -d "$REPO/android/app/src/main/assets/public" ] || [ ! -d "$REPO/packages/client/out-mobile" ]; then
  echo "Building fallback static export (first run)..."
  (cd "$REPO" && pnpm build:mobile android)
fi

# ── Capacitor sync + deploy ───────────────────────────────
# The one legitimate bare `cap sync`: in live reload the only thing that has to
# change is server.url in the generated capacitor.config.json, and going through
# build-mobile.mjs would rebuild the export into packages/client/.next — which
# the dev server started above now owns.
echo "Syncing Capacitor (server.url = $CAP_DEV_URL)"
export CAP_DEV_URL
(cd "$REPO" && npx cap sync android)

TARGET_SERIAL=$(adb devices | awk 'NR>1 && $2 == "device" { print $1; exit }')
if [ -z "$TARGET_SERIAL" ]; then
  echo "No device visible to adb."
  exit 1
fi

echo "Installing + launching on $TARGET_SERIAL..."
(cd "$REPO" && npx cap run android --no-sync --target "$TARGET_SERIAL")

echo ""
echo "Live-reload active. Ctrl+C to stop (emulator stays running)."
wait "$NEXT_PID"
