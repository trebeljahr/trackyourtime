#!/usr/bin/env bash
#
# One-command iOS Simulator dev loop with live reload.
#
# Mirror of scripts/android-dev.sh for iOS Simulator.
#
# This script starts the Next dev server and points the WebView at it. It does
# NOT start the API — run that separately, and tell this script where it is:
#
#   API_PORT=51590 PORT=33920 pnpm run dev     # in another terminal
#   API_PORT=51590 pnpm dev:ios
#
# NEXT_PUBLIC_API_URL is read by the Next dev server at start and baked into
# the fallback bundle, so a wrong API_PORT here is a phone that loads and then
# fails every request — which is why it is exported explicitly rather than left
# to whatever happens to be in the environment.
#
# Under live reload the document origin is http://localhost:$NEXT_PORT, which is
# the same *site* as a localhost API (port is not part of a site). Cookie auth
# therefore appears to work here and fails from capacitor://localhost in a real
# bundle. Verify auth changes against `pnpm build:mobile`, never against this.
#
# Env overrides:
#   SIM=<device name>   simulator to use (default: iPhone 17)
#   NEXT_PORT=<n>       Next.js dev port (default: 51730)
#   API_PORT=<n>        port the API is already listening on (default: 5159)
#   NEXT_PUBLIC_API_URL full API origin override, wins over API_PORT
#   LAN_IP=<ip>         override host (default: localhost — simulators
#                       share the Mac's network namespace)
#   CAP_DEV_URL=<url>   full WebView dev URL override, e.g.
#                       https://<slug>.local.<your-domain>/
#   IOS_HEADLESS=1      boot with simctl only, never open Simulator.app (agent
#                       runs; screenshot with `xcrun simctl io`). Otherwise
#                       Simulator.app is opened with `open -g`, in the
#                       background, so it never takes focus.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

SIM_NAME="${SIM:-iPhone 17}"
# Not 7130: that is `pnpm dev:desktop`'s Electron dev port, and this script used
# to take it by force. Nothing else in the repo claims 51730.
NEXT_PORT="${NEXT_PORT:-51730}"
API_PORT="${API_PORT:-5159}"
DEV_HOST="${LAN_IP:-localhost}"

export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:$API_PORT}"

NEXT_PID=""

cleanup() {
  echo ""
  echo "Stopping Next.js dev server"
  # Only the process this script started. `lsof -ti:$PORT | xargs kill -9` would
  # also take out whatever a colleague, another agent or another worktree had
  # on that port.
  if [ -n "$NEXT_PID" ]; then
    kill -TERM "$NEXT_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "   (simulator left running — next dev:ios is instant)"
}
trap cleanup EXIT INT TERM

if lsof -ti:"$NEXT_PORT" > /dev/null 2>&1; then
  echo "Port $NEXT_PORT is already in use — not killing it, it may not be mine."
  echo "  Who has it:  lsof -nP -iTCP:$NEXT_PORT -sTCP:LISTEN"
  echo "  Or pick another:  NEXT_PORT=<n> pnpm dev:ios"
  exit 1
fi

if ! curl -s -o /dev/null --max-time 2 "$NEXT_PUBLIC_API_URL/api/health"; then
  echo "Warning: nothing answering at $NEXT_PUBLIC_API_URL — the app will load"
  echo "  and then fail every request. Start the API with:"
  echo "    API_PORT=$API_PORT PORT=33920 pnpm run dev"
  echo ""
fi

# ── Simulator ─────────────────────────────────────────────
if xcrun simctl list devices | grep -q "Booted"; then
  BOOTED_NAME=$(xcrun simctl list devices | grep "Booted" | head -1 | sed -E 's/^[[:space:]]+(.*) \([A-F0-9-]+\).*/\1/')
  echo "Simulator already booted: $BOOTED_NAME"
else
  echo "Booting simulator: $SIM_NAME"
  UDID=$(xcrun simctl list devices available \
    | grep -F "$SIM_NAME" \
    | head -1 \
    | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
  if [ -z "$UDID" ]; then
    echo "Simulator '$SIM_NAME' not found."
    echo "Available: xcrun simctl list devices available"
    exit 1
  fi
  xcrun simctl boot "$UDID"
  # -g: open in the background. A plain `open -a` activates Simulator.app and
  # takes keyboard focus from whatever the person at the Mac is typing into.
  if [ "${IOS_HEADLESS:-}" != "1" ]; then
    open -g -a Simulator
  fi
  until xcrun simctl list devices | grep -F "$UDID" | grep -q "Booted"; do
    sleep 1
  done
  echo "Simulator ready"
fi

# ── Fallback bundle ───────────────────────────────────────
# What the WebView falls back to when the dev server is not answering. Built
# against the same API origin, so the fallback is not quietly a different app.
if [ ! -d "$REPO/packages/client/out-mobile" ] || [ ! -d "$REPO/ios/App/App/public" ]; then
  echo "Building fallback static export (first run)..."
  (cd "$REPO" && pnpm build:mobile ios)
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

# ── Capacitor sync + deploy ───────────────────────────────
# The one legitimate bare `cap sync`: in live reload the only thing that has to
# change is server.url in the generated capacitor.config.json, and going through
# build-mobile.mjs would rebuild the export into packages/client/.next — which
# the dev server started above now owns.
echo "Syncing Capacitor (server.url = $CAP_DEV_URL)"
export CAP_DEV_URL
(cd "$REPO" && npx cap sync ios)

SIM_UDID=$(xcrun simctl list devices | grep "Booted" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
if [ -z "$SIM_UDID" ]; then
  echo "No booted simulator found."
  exit 1
fi

echo "Building + launching on $SIM_UDID..."
(cd "$REPO" && npx cap run ios --no-sync --target "$SIM_UDID")

echo ""
echo "Live-reload active. Ctrl+C to stop (simulator stays running)."
wait "$NEXT_PID"
