#!/usr/bin/env bash
# Starts or stops one Track Your Time server, with its MongoDB and Redis, for
# the cross-version compatibility suite (.github/workflows/compat.yml).
#
#   scripts/compat-server.sh up     # prints COMPAT_API_URL=… on its last line
#   scripts/compat-server.sh down
#
# It drives a docker-compose.selfhost.yml — the one of the release being
# tested, so the server runs with that release's own environment — but starts
# only `server` and what it depends on, never Caddy or the web client. The
# server port is published on 127.0.0.1 only.
#
# ── Environment ──────────────────────────────────────────────────────────
#
#   COMPAT_COMPOSE_FILE   required: path to the docker-compose.selfhost.yml.
#   COMPAT_SERVER_IMAGE   required: image to run, e.g.
#                         ghcr.io/trebeljahr/trackyourtime-server:v0.1.0
#   COMPAT_PULL           "anonymous" (default): pull with an empty Docker
#                         config, the way a self-hoster with no login does;
#                         "never": the image was built locally.
#   COMPAT_PROJECT        compose project name, default compat-<pid>; set it
#                         for both `up` and `down`. Each project has its own
#                         volumes and database name.
#   COMPAT_PORT           host port, default a free random port 49152-65535.
#   COMPAT_STATE_DIR      where `up` writes the env and override files `down`
#                         reuses. Default $RUNNER_TEMP, else $TMPDIR.
#
# `down` removes only this project's containers, network and volumes.

set -euo pipefail

ACTION="${1:-}"
# Stable across `up` and `down`, which are separate invocations.
STATE_DIR="${COMPAT_STATE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}/compat-${COMPAT_PROJECT:-default}"
mkdir -p "$STATE_DIR"

fail() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    printf '::error::%s\n' "$*" >&2
  else
    printf 'ERROR: %s\n' "$*" >&2
  fi
  exit 1
}

free_port() {
  local port
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port=$((RANDOM % 16000 + 49152))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return 0
    fi
  done
  fail "no free port found"
}

compose() {
  local stack_project stack_file
  stack_project="$(sed -n 1p "$STATE_DIR/project")"
  stack_file="$(sed -n 2p "$STATE_DIR/project")"
  DOCKER_CONFIG="$STATE_DIR/docker" docker compose \
    -p "$stack_project" \
    --env-file "$STATE_DIR/env" \
    -f "$stack_file" \
    -f "$STATE_DIR/override.yml" \
    "$@"
}

case "$ACTION" in
  up)
    : "${COMPAT_COMPOSE_FILE:?set COMPAT_COMPOSE_FILE}"
    : "${COMPAT_SERVER_IMAGE:?set COMPAT_SERVER_IMAGE}"
    [ -f "$COMPAT_COMPOSE_FILE" ] || fail "$COMPAT_COMPOSE_FILE does not exist"
    project="${COMPAT_PROJECT:-compat-$$}"
    port="${COMPAT_PORT:-$(free_port)}"
    case "${COMPAT_PULL:-anonymous}" in
      anonymous) pull_policy=missing ;;
      never) pull_policy=never ;;
      *) fail "COMPAT_PULL must be anonymous or never" ;;
    esac

    # An empty Docker config: no registry login and no credential helper, so
    # a private image fails here exactly as it would for a self-hoster.
    mkdir -p "$STATE_DIR/docker"
    printf '{}\n' >"$STATE_DIR/docker/config.json"

    # Project name, then the absolute compose file, one per line.
    {
      echo "$project"
      echo "$(cd "$(dirname "$COMPAT_COMPOSE_FILE")" && pwd)/$(basename "$COMPAT_COMPOSE_FILE")"
    } >"$STATE_DIR/project"

    # Only what the compose file interpolates. APP_DOMAIN is required by the
    # Caddy service's definition even though Caddy is never started.
    {
      echo "APP_DOMAIN=localhost"
      echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
      echo "APP_URL=http://127.0.0.1:$port"
      echo "MONGODB_URI=mongodb://mongo:27017/trackyourtime_${project//[^A-Za-z0-9]/_}"
    } >"$STATE_DIR/env"

    cat >"$STATE_DIR/override.yml" <<EOF
services:
  server:
    image: $COMPAT_SERVER_IMAGE
    pull_policy: $pull_policy
    ports:
      - "127.0.0.1:$port:5159"
EOF

    if [ "$pull_policy" = "missing" ]; then
      echo "==> Pulling $COMPAT_SERVER_IMAGE anonymously"
      DOCKER_CONFIG="$STATE_DIR/docker" docker pull "$COMPAT_SERVER_IMAGE" \
        || fail "anonymous pull of $COMPAT_SERVER_IMAGE failed; is the package public?"
    fi

    echo "==> Starting $project (server, mongo, redis) on 127.0.0.1:$port"
    if ! compose up -d --no-build --wait --wait-timeout 300 server; then
      compose ps -a || true
      compose logs --no-color --tail 200 || true
      fail "the server did not become healthy"
    fi

    for _ in $(seq 1 60); do
      if curl -sf "http://127.0.0.1:$port/api/health" >/dev/null; then
        curl -s "http://127.0.0.1:$port/api/health"
        echo
        echo "COMPAT_API_URL=http://127.0.0.1:$port"
        exit 0
      fi
      sleep 2
    done
    compose logs --no-color --tail 200 || true
    fail "/api/health did not answer on 127.0.0.1:$port"
    ;;

  down)
    [ -f "$STATE_DIR/project" ] || exit 0
    if [ "${COMPAT_LOGS:-}" = "1" ]; then
      compose ps -a || true
      compose logs --no-color --tail 200 || true
    fi
    compose down -v --remove-orphans
    ;;

  *)
    fail "usage: scripts/compat-server.sh up|down"
    ;;
esac
