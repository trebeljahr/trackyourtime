#!/usr/bin/env bash
# Proves a published release can be used by someone holding no credentials:
# pulls both self-host images anonymously, starts docker-compose.selfhost.yml
# from them, and checks the running stack through its proxy.
#
#   scripts/verify-release-images.sh [vX.Y.Z]      # default: v<root package.json version>
#
# Two callers, one implementation:
#   - release.yml's `smoke` job, on amd64 and arm64, BEFORE `X.Y` and `latest`
#     are moved onto the release;
#   - the maintainer, after a publish (docs/releasing.md).
#
# ── Run it locally against a NON-default Docker VM ───────────────────────
#
#   colima start -p tt-verify --cpu 2 --memory 2
#   DOCKER_CONTEXT=colima-tt-verify CHECK_FLOATING=1 scripts/verify-release-images.sh v0.1.0
#
# The script only ever removes the containers, network and volumes of its own
# compose project (tracktime-verify-<pid>), but the default colima VM is where
# real dev containers live, so it refuses the `colima` context unless
# ALLOW_DEFAULT_CONTEXT=1. The images it pulls stay in the VM's image store.
#
# ── What it checks, in order (any failure exits non-zero) ────────────────
#
#   1. Registry, curl only: an anonymous pull token for each package, the
#      exact tag's manifest, and that the manifest is a list naming
#      linux/amd64 AND linux/arm64. A package GHCR still has PRIVATE — which
#      is what the first push of tracktime-client-selfhost creates — fails
#      here with the fix spelled out.
#   2. Docker, anonymously: a throwaway DOCKER_CONFIG with no auths and no
#      credential store (your real ~/.docker is never written to, and your
#      login is never touched), `buildx imagetools inspect` for both arches,
#      and a `docker pull` of both images for the host's platform.
#   3. The stack: `compose up --no-build --wait` of the TAGGED
#      docker-compose.selfhost.yml, with a generated env file and caddy's
#      ports overridden to one loopback port.
#   4. Pulled, not built: both image refs carry a registry digest.
#   5. /api/health through Caddy: status ok, db true, webUrl == APP_URL, and
#      version == EXPECTED_SHA (or at least non-empty).
#   6. GET / is the web app (200, text/html, an <html> document).
#   7. GET /api/auth/get-session answers JSON — the proxy routes /api to the
#      server rather than letting the static app swallow it.
#   8. With CHECK_FLOATING=1: `X.Y` and `latest` resolve to the same index
#      digest as the version tag (use after release.yml's promote job).
#
# ── Environment ──────────────────────────────────────────────────────────
#
#   VERIFY_PORT     host port for caddy. Default 80 when CI is set, else a
#                   free random port in 49152-65535. Bound on 127.0.0.1 only.
#   EXPECTED_SHA    the commit /api/health must report as `version`.
#   IMAGE_REPO      <owner>/<repo> the images are named after. Default
#                   trebeljahr/tracktime; point it at a fork's packages to
#                   exercise the script before a real release exists.
#   CHECK_FLOATING  1 = also check the `X.Y` and `latest` tags (step 8).
#   REGISTRY_ONLY   1 = stop after step 1; no Docker needed.
#   KEEP            1 = leave the stack running for inspection.
#   ALLOW_DEFAULT_CONTEXT  1 = allow the default colima context.
#
# Needs bash (3.2 is enough), curl, jq and openssl; Docker with the compose
# plugin (>= 2.24.4, for `!override`) for steps 2-7. macOS and Linux.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.selfhost.yml"
DEFAULT_IMAGE_REPO="trebeljahr/tracktime"

# ── Output ───────────────────────────────────────────────────────────────

RESULT="FAIL"
FAIL_REASON="exited before the checks finished"
STACK_STARTED=0
TMP_DIR=""
PROJECT=""

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

warn() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    printf '::warning::%s\n' "$*" >&2
  else
    printf 'WARNING: %s\n' "$*" >&2
  fi
}

# Every failure goes through here: one line an Actions log annotates, the
# same text in the job summary, then the EXIT trap tears down and prints FAIL.
fail() {
  FAIL_REASON="$1"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    # Annotations are one line; the summary keeps the full text.
    printf '::error::%s\n' "$(printf '%s' "$1" | tr '\n' ' ')" >&2
  else
    printf 'ERROR: %s\n' "$1" >&2
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### Release image check failed\n\n%s\n\n' "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not on PATH."
}

# ── Teardown ─────────────────────────────────────────────────────────────

compose_project() {
  # Every value the compose file interpolates is unset first, so a
  # MONGODB_URI or APP_DOMAIN exported in the caller's shell (a dev setup
  # has them) cannot override the generated env file and test something
  # other than the documented defaults.
  # shellcheck disable=SC2086 # COMPOSE_UNSET is a list of `-u NAME` words.
  env $COMPOSE_UNSET "${COMPOSE_CMD[@]}" \
    -p "$PROJECT" \
    --env-file "$TMP_DIR/env" \
    -f "$COMPOSE_FILE" \
    -f "$TMP_DIR/override.yml" \
    "$@"
}

finish() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ]; then RESULT="FAIL"; fi

  if [ "$STACK_STARTED" = "1" ]; then
    if [ "$RESULT" != "PASS" ]; then
      say "Stack state at failure"
      compose_project ps -a
      compose_project logs --no-color --tail 200
    fi
    if [ "${KEEP:-}" = "1" ]; then
      say "KEEP=1: leaving project $PROJECT running. Remove it with:"
      note "DOCKER_CONFIG=$TMP_DIR/docker docker compose -p $PROJECT --env-file $TMP_DIR/env -f $COMPOSE_FILE -f $TMP_DIR/override.yml down -v"
    else
      say "Removing project $PROJECT (its containers, network and volumes only)"
      compose_project down -v --remove-orphans >/dev/null 2>&1 \
        || warn "compose down failed; check 'docker ps -a --filter label=com.docker.compose.project=$PROJECT'"
    fi
  fi

  # The temp dir holds the env file and override a kept stack needs for its
  # own `down`, so it survives exactly when the stack does.
  if [ -n "$TMP_DIR" ] && { [ "${KEEP:-}" != "1" ] || [ "$STACK_STARTED" != "1" ]; }; then
    rm -rf "$TMP_DIR"
  fi

  echo
  if [ "$RESULT" = "PASS" ]; then
    printf 'PASS: %s\n' "$PASS_SUMMARY"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      printf '### Release image check passed\n\n%s\n' "$PASS_SUMMARY" >>"$GITHUB_STEP_SUMMARY"
    fi
  else
    printf 'FAIL: %s\n' "$FAIL_REASON"
  fi
  exit "$status"
}
PASS_SUMMARY=""
COMPOSE_UNSET=""
COMPOSE_CMD=(docker compose)
trap finish EXIT

# ── Arguments ────────────────────────────────────────────────────────────

need curl
need jq

if [ "$#" -gt 1 ]; then
  fail "usage: scripts/verify-release-images.sh [vX.Y.Z]"
fi
VERSION="${1:-v$(jq -r '.version' "$REPO_ROOT/package.json")}"
if ! printf '%s' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  fail "'$VERSION' is not a vX.Y.Z release tag."
fi

IMAGE_REPO="$(printf '%s' "${IMAGE_REPO:-$DEFAULT_IMAGE_REPO}" | tr '[:upper:]' '[:lower:]')"
case "$IMAGE_REPO" in
  */*) ;;
  *) fail "IMAGE_REPO must be <owner>/<repo>, got '$IMAGE_REPO'." ;;
esac
IMAGE_OWNER="${IMAGE_REPO%%/*}"
SERVER_PKG="${IMAGE_REPO#*/}-server"
CLIENT_PKG="${IMAGE_REPO#*/}-client-selfhost"
SERVER_REF="ghcr.io/$IMAGE_OWNER/$SERVER_PKG:$VERSION"
CLIENT_REF="ghcr.io/$IMAGE_OWNER/$CLIENT_PKG:$VERSION"

# ── 1. Registry probe (curl only) ────────────────────────────────────────

ACCEPT_LIST='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
ACCEPT_ANY="$ACCEPT_LIST, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

private_hint() {
  local pkg="$1"
  cat <<EOF
anonymous pull of $pkg:$VERSION was denied. The package is private or does not exist. The first push of $pkg creates it PRIVATE: GitHub -> Packages -> $pkg -> Package settings -> Change visibility -> Public (https://github.com/users/$IMAGE_OWNER/packages/container/$pkg/settings), then re-run this check ("Re-run failed jobs" in the release run).
EOF
}

# Sets TOKEN to an anonymous pull token for a package, or fails with the
# hint. GHCR answers the TOKEN request with 403 DENIED for a private or
# missing package; a manifest request made without a valid token would answer
# 404 instead and point at the wrong problem.
#
# These helpers set globals rather than print: `fail` inside a $(...) would
# exit only the subshell, and the real reason would never reach the FAIL line.
registry_token() {
  local pkg="$1" body code
  body="$(curl -sS --max-time 20 -w '\n%{http_code}' \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:$IMAGE_OWNER/$pkg:pull")" \
    || fail "could not reach ghcr.io to request a pull token for $pkg."
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  case "$code" in
    200) ;;
    401 | 403) fail "$(private_hint "$pkg")" ;;
    *) fail "ghcr.io answered HTTP $code to a pull-token request for $pkg: $body" ;;
  esac
  TOKEN="$(jq -r '.token // empty' <<<"$body")"
  [ -n "$TOKEN" ] || fail "ghcr.io issued no pull token for $pkg."
}

# GET a manifest into file $2; sets M_CODE and M_DIGEST.
fetch_manifest() {
  local pkg="$1" out="$2" tag="$3" token="$4" headers
  headers="$out.headers"
  M_CODE="$(curl -sS --max-time 20 -o "$out" -D "$headers" -w '%{http_code}' \
    -H "Authorization: Bearer $token" -H "Accept: $ACCEPT_ANY" \
    "https://ghcr.io/v2/$IMAGE_OWNER/$pkg/manifests/$tag")" \
    || fail "could not reach ghcr.io to fetch $pkg:$tag."
  M_DIGEST="$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }' | tail -n 1)"
  M_DIGEST="${M_DIGEST:-none}"
}

probe_package() {
  local pkg="$1" manifest digest media platforms want
  say "Registry: ghcr.io/$IMAGE_OWNER/$pkg:$VERSION (anonymous)"
  registry_token "$pkg"

  manifest="$TMP_DIR/$pkg.json"
  fetch_manifest "$pkg" "$manifest" "$VERSION" "$TOKEN"
  digest="$M_DIGEST"
  case "$M_CODE" in
    200) ;;
    401 | 403) fail "$(private_hint "$pkg")" ;;
    404) fail "$pkg:$VERSION: tag not published (MANIFEST_UNKNOWN) — did release.yml's merge job run for $VERSION?" ;;
    *) fail "ghcr.io answered HTTP $M_CODE for $pkg:$VERSION: $(head -c 300 "$manifest")" ;;
  esac

  media="$(jq -r '.mediaType // empty' "$manifest")"
  case "$ACCEPT_LIST" in
    *"$media"*) ;;
    *) fail "$pkg:$VERSION is a single-platform manifest ($media), not a multi-arch list." ;;
  esac
  platforms="$(jq -r '[.manifests[] | .platform // {} | select(.os == "linux") | "linux/" + .architecture] | unique | join(" ")' "$manifest")"
  for want in linux/amd64 linux/arm64; do
    case " $platforms " in
      *" $want "*) ;;
      *) fail "$pkg:$VERSION lists [$platforms] and is missing $want." ;;
    esac
  done
  note "digest $digest, platforms: $platforms"

  if [ "${CHECK_FLOATING:-}" = "1" ]; then
    case "$VERSION" in
      *-*)
        note "prerelease: no floating tags to check"
        ;;
      *)
        local series floating
        series="$(printf '%s' "$VERSION" | sed -E 's/^v([0-9]+)\.([0-9]+)\..*/\1.\2/')"
        for floating in "$series" latest; do
          fetch_manifest "$pkg" "$TMP_DIR/$pkg-$floating.json" "$floating" "$TOKEN"
          [ "$M_CODE" = "200" ] \
            || fail "$pkg:$floating: HTTP $M_CODE — release.yml's promote job has not moved it (it runs only after smoke passes)."
          [ "$M_DIGEST" = "$digest" ] \
            || fail "$pkg:$floating points at $M_DIGEST, not $VERSION ($digest). Expected when a newer release owns that tag; otherwise promote did not run."
          note "$floating -> same digest"
        done
        ;;
    esac
  fi
}

TOKEN=""
M_CODE=""
M_DIGEST=""
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tt-verify.XXXXXX")"
probe_package "$SERVER_PKG"
probe_package "$CLIENT_PKG"

if [ "${REGISTRY_ONLY:-}" = "1" ]; then
  RESULT="PASS"
  PASS_SUMMARY="$SERVER_PKG:$VERSION and $CLIENT_PKG:$VERSION are anonymously pullable multi-arch lists (registry probe only; nothing was started)."
  exit 0
fi

# ── 2. Anonymous Docker ──────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 \
  || fail "the docker CLI is not on PATH, so nothing could be pulled or started. Install it, or run with REGISTRY_ONLY=1 for the registry probe alone."
need openssl

CONTEXT="$(docker context show 2>/dev/null || echo default)"
if [ "$CONTEXT" = "colima" ] && [ "${ALLOW_DEFAULT_CONTEXT:-}" != "1" ]; then
  fail "refusing to run against the default colima VM (context 'colima'). Start a separate profile: colima start -p tt-verify --cpu 2 --memory 2, then DOCKER_CONTEXT=colima-tt-verify. ALLOW_DEFAULT_CONTEXT=1 overrides."
fi

# A config dir with the context and the CLI plugins, and nothing that can
# authenticate: no auths, no credsStore, no credHelpers. Your real config is
# only read, never written, and stays logged in.
REAL_DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
mkdir -p "$TMP_DIR/docker"
if [ -f "$REAL_DOCKER_CONFIG/config.json" ]; then
  jq --arg ctx "$CONTEXT" '{currentContext: $ctx} + (if .cliPluginsExtraDirs then {cliPluginsExtraDirs} else {} end)' \
    "$REAL_DOCKER_CONFIG/config.json" >"$TMP_DIR/docker/config.json"
else
  jq -n --arg ctx "$CONTEXT" '{currentContext: $ctx}' >"$TMP_DIR/docker/config.json"
fi
for sub in contexts cli-plugins; do
  if [ -d "$REAL_DOCKER_CONFIG/$sub" ]; then
    ln -s "$REAL_DOCKER_CONFIG/$sub" "$TMP_DIR/docker/$sub"
  fi
done
export DOCKER_CONFIG="$TMP_DIR/docker"

say "Docker: context '$CONTEXT', anonymous config $DOCKER_CONFIG"
docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon for context '$CONTEXT'."

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  fail "Docker Compose is not installed (neither 'docker compose' nor 'docker-compose')."
fi
COMPOSE_VERSION="$("${COMPOSE_CMD[@]}" version --short 2>/dev/null | sed 's/^v//')"
if [ "$(printf '%s\n%s\n' "2.24.4" "$COMPOSE_VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" != "2.24.4" ]; then
  fail "Docker Compose $COMPOSE_VERSION is too old: the port override needs 2.24.4 or newer."
fi
note "compose $COMPOSE_VERSION"

if docker buildx version >/dev/null 2>&1; then
  for ref in "$SERVER_REF" "$CLIENT_REF"; do
    platforms="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' 2>&1)" \
      || fail "docker buildx imagetools inspect $ref failed without credentials: $platforms"
    platforms="$(jq -r '[.manifests[] | .platform // {} | select(.os == "linux") | "linux/" + .architecture] | unique | join(" ")' <<<"$platforms")"
    case " $platforms " in
      *" linux/amd64 "*" linux/arm64 "*) note "imagetools: $ref -> $platforms" ;;
      *) fail "imagetools: $ref lists [$platforms], expected linux/amd64 and linux/arm64." ;;
    esac
  done
else
  warn "docker buildx is not installed; the manifest list was checked over the registry API in step 1 only."
fi

for ref in "$SERVER_REF" "$CLIENT_REF"; do
  say "Pulling $ref"
  docker pull --quiet "$ref" >/dev/null || fail "anonymous docker pull of $ref failed."
done

# ── 3. Start the stack ───────────────────────────────────────────────────

[ -f "$COMPOSE_FILE" ] || fail "$COMPOSE_FILE not found."

port_busy() {
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

if [ -n "${VERIFY_PORT:-}" ]; then
  PORT="$VERIFY_PORT"
elif [ -n "${CI:-}" ]; then
  PORT=80
else
  PORT=""
  for _ in 1 2 3; do
    candidate=$((49152 + RANDOM % 16384))
    if ! port_busy "$candidate"; then
      PORT="$candidate"
      break
    fi
  done
  [ -n "$PORT" ] || fail "no free port found in 3 tries; set VERIFY_PORT."
fi
port_busy "$PORT" && fail "port $PORT is already in use; set VERIFY_PORT to a free one."

if [ "$PORT" = "80" ]; then
  APP_URL="http://localhost"
else
  APP_URL="http://localhost:$PORT"
fi
export APP_URL

# APP_DOMAIN with an http:// scheme makes Caddy serve plain HTTP on that
# port, with no certificate and no redirect, and APP_URL is spelled exactly
# as curl below reaches it — better-auth's origin check is a literal match.
cat >"$TMP_DIR/env" <<EOF
APP_DOMAIN=$APP_URL
APP_URL=$APP_URL
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
TRACKTIME_VERSION=$VERSION
EOF

# Only caddy's ports change. `!override` REPLACES the list (a plain merge
# would add to 80/443, which a runner or a laptop may not have free).
{
  echo "services:"
  echo "  caddy:"
  echo "    ports: !override"
  echo "      - \"127.0.0.1:$PORT:$PORT\""
  # For the published repo the compose file's own image refs are what is
  # tested (step below asserts they resolve to the release). A fork's
  # packages have other names, so only then are the refs replaced.
  if [ "$IMAGE_REPO" != "$DEFAULT_IMAGE_REPO" ]; then
    echo "  server:"
    echo "    image: $SERVER_REF"
    echo "  client:"
    echo "    image: $CLIENT_REF"
  fi
} >"$TMP_DIR/override.yml"

for var in $(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" | sed 's/^\${//' | sort -u) \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES; do
  COMPOSE_UNSET="$COMPOSE_UNSET -u $var"
done
PROJECT="tracktime-verify-$$"

config_json="$(compose_project config --format json 2>&1)" \
  || fail "compose rejected the configuration: $config_json"
for pair in "server:$SERVER_REF" "client:$CLIENT_REF"; do
  service="${pair%%:*}"
  want="${pair#*:}"
  got="$(jq -r --arg s "$service" '.services[$s].image' <<<"$config_json")"
  [ "$got" = "$want" ] || fail "docker-compose.selfhost.yml resolves $service to '$got', expected '$want'."
done

say "Starting project $PROJECT on $APP_URL (waits for every healthcheck, up to 300s)"
STACK_STARTED=1
compose_project up -d --no-build --wait --wait-timeout 300 \
  || fail "compose up did not reach healthy within 300s (logs below)."

# ── 4. Pulled, not built ─────────────────────────────────────────────────

for ref in "$SERVER_REF" "$CLIENT_REF"; do
  digests="$(docker image inspect --format '{{len .RepoDigests}}' "$ref" 2>/dev/null || echo 0)"
  [ "$digests" -ge 1 ] \
    || fail "$ref has no registry digest: it was built locally, not pulled from ghcr.io."
done
note "both images carry a registry digest"

# ── 5. /api/health through the proxy ─────────────────────────────────────

say "GET $APP_URL/api/health"
health=""
deadline=$(($(date +%s) + 180))
while :; do
  if health="$(curl -fsS --max-time 5 "$APP_URL/api/health" 2>/dev/null)"; then
    break
  fi
  [ "$(date +%s)" -lt "$deadline" ] || fail "$APP_URL/api/health did not answer 200 within 180s."
  sleep 3
done
note "$health"

jq -e '.status == "ok"' <<<"$health" >/dev/null || fail "/api/health status is not ok: $health"
jq -e '.db == true' <<<"$health" >/dev/null || fail "/api/health reports db=false: the server is up but not connected to MongoDB. $health"
jq -e '.webUrl == env.APP_URL' <<<"$health" >/dev/null \
  || fail "/api/health webUrl is not $APP_URL: APP_URL did not reach the server. $health"
if [ -n "${EXPECTED_SHA:-}" ]; then
  EXPECTED_SHA="$EXPECTED_SHA" jq -e '.version == env.EXPECTED_SHA' <<<"$health" >/dev/null \
    || fail "/api/health version is not $EXPECTED_SHA: the image was not built from the release commit (or without COMMIT_SHA). $health"
elif ! jq -e '(.version // "") != ""' <<<"$health" >/dev/null; then
  warn "/api/health version is empty: the server image was built without COMMIT_SHA."
fi

# ── 6. The web app ───────────────────────────────────────────────────────

say "GET $APP_URL/"
code="$(curl -sS --max-time 10 -o "$TMP_DIR/index.html" -D "$TMP_DIR/index.headers" -w '%{http_code}' "$APP_URL/")" \
  || fail "GET $APP_URL/ failed to connect."
[ "$code" = "200" ] || fail "GET $APP_URL/ answered HTTP $code, expected 200."
grep -qi '^content-type: text/html' "$TMP_DIR/index.headers" \
  || fail "GET $APP_URL/ is not text/html: $(grep -i '^content-type' "$TMP_DIR/index.headers" | tr -d '\r')"
grep -qi '<html' "$TMP_DIR/index.html" || fail "GET $APP_URL/ returned no <html> document."
note "200 text/html"

# ── 7. /api routing ──────────────────────────────────────────────────────

say "GET $APP_URL/api/auth/get-session"
curl -sS --max-time 10 -o /dev/null -D "$TMP_DIR/session.headers" "$APP_URL/api/auth/get-session" \
  || fail "GET $APP_URL/api/auth/get-session failed to connect."
grep -qi '^content-type: application/json' "$TMP_DIR/session.headers" \
  || fail "GET /api/auth/get-session is not JSON ($(grep -i '^content-type' "$TMP_DIR/session.headers" | tr -d '\r')): the proxy is sending /api to the web app, not the server."
note "application/json"

RESULT="PASS"
PASS_SUMMARY="$VERSION pulled anonymously ($SERVER_PKG, $CLIENT_PKG; linux/amd64 + linux/arm64 listed) and served healthy on $(uname -m) at $APP_URL."
