#!/usr/bin/env bash
#
# Verify a Track Your Time self-host install, end to end.
#
#   scripts/selfhost-check.sh track.example.com
#   scripts/selfhost-check.sh track.example.com --token tt_...
#   APP_URL=http://localhost scripts/selfhost-check.sh localhost --insecure
#
# Prints one PASS, FAIL or SKIP line per check, with a one-line fix under each
# FAIL, and exits non-zero when any check fails. Docs: docs/self-hosting.md.
#
# Where to run it:
#   - On the server, from the directory holding docker-compose.selfhost.yml.
#     All checks run, including the container states and the comparison of
#     DNS with this machine's public IP. The IP comparison runs only once the
#     stack's containers exist on this machine.
#   - Anywhere else. The container checks and the IP comparison are skipped,
#     and every HTTP check still runs against the domain.
#
# Needs curl. Uses dig (or getent, or host) for DNS and docker for the
# container checks when they are installed, and skips those checks when not.
#
# Options and environment:
#   <domain>             The domain in APP_DOMAIN. Read from ./.env when omitted.
#   --token <tt_...>     Also call GET /api/v1/me with this API token.
#                        Or set TRACKYOURTIME_API_TOKEN.
#   --insecure           Accept an untrusted certificate (a local trial behind
#                        Caddy's internal CA). The certificate check is then
#                        reported as SKIP rather than FAIL.
#   APP_URL              The origin to test, when it is not https://<domain>.
#                        Read from ./.env when set there.
#   SELFHOST_COMPOSE_FILE  Compose file for the container checks.
#                        Default: docker-compose.selfhost.yml in the cwd.
#   SELFHOST_PUBLIC_IP   This machine's public IPv4, to skip the lookup.
#                        The lookup otherwise asks https://ifconfig.me.

set -u

TIMEOUT=15
COMPOSE_FILE_PATH=${SELFHOST_COMPOSE_FILE:-docker-compose.selfhost.yml}
TOKEN=${TRACKYOURTIME_API_TOKEN:-}
INSECURE=0
DOMAIN=""

usage() {
  sed -n '3,36p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --insecure | -k)
      INSECURE=1
      ;;
    --token)
      if [ $# -lt 2 ]; then
        echo "--token needs a value" >&2
        exit 2
      fi
      TOKEN=$2
      shift
      ;;
    --token=*)
      TOKEN=${1#--token=}
      ;;
    -*)
      echo "Unknown option: $1 (see --help)" >&2
      exit 2
      ;;
    *)
      if [ -n "$DOMAIN" ]; then
        echo "Only one domain, please: got '$DOMAIN' and '$1'" >&2
        exit 2
      fi
      DOMAIN=$1
      ;;
  esac
  shift
done

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL  curl is not installed"
  echo "      fix: sudo apt-get install -y curl"
  exit 2
fi

# ── Resolve what to test ──────────────────────────────────────────────────

# One value from ./.env, only for a plain KEY=value line. Never sources the
# file: it holds BETTER_AUTH_SECRET, and nothing else in it is read or printed.
env_file_value() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" .env | tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

ENV_DOMAIN=$(env_file_value APP_DOMAIN)
if [ -z "$DOMAIN" ] && [ -z "${APP_URL:-}" ]; then
  DOMAIN=$ENV_DOMAIN
fi

# Accept a pasted URL as the domain: keep only the host.
DOMAIN=${DOMAIN#http://}
DOMAIN=${DOMAIN#https://}
DOMAIN=${DOMAIN%%/*}

BASE=${APP_URL:-}
if [ -z "$BASE" ] && { [ -z "$DOMAIN" ] || [ "$DOMAIN" = "$ENV_DOMAIN" ]; }; then
  BASE=$(env_file_value APP_URL)
fi
if [ -z "$BASE" ] && [ -n "$DOMAIN" ]; then
  BASE="https://$DOMAIN"
fi
BASE=${BASE%/}

if [ -z "$BASE" ]; then
  echo "Usage: scripts/selfhost-check.sh <domain> [--token tt_...] [--insecure]" >&2
  echo "No domain given, and no APP_DOMAIN found in ./.env" >&2
  exit 2
fi

# The host to resolve comes from the URL, so APP_URL alone is enough.
HOST=${BASE#*://}
HOST=${HOST%%/*}
HOST_NO_PORT=${HOST%:*}
case $HOST in
  \[*) HOST_NO_PORT=${HOST%%]*}] ;;
esac
[ -n "$DOMAIN" ] || DOMAIN=$HOST_NO_PORT

case $BASE in
  https://*) SCHEME=https ;;
  http://*) SCHEME=http ;;
  *)
    echo "APP_URL must start with http:// or https://, got: $BASE" >&2
    exit 2
    ;;
esac

HAS_COMPOSE_FILE=0
if [ -f "$COMPOSE_FILE_PATH" ]; then
  HAS_COMPOSE_FILE=1
fi
HAS_DOCKER=0
if command -v docker >/dev/null 2>&1; then
  HAS_DOCKER=1
fi

# "This machine runs the stack" means the compose project has containers here.
# A compose file alone is not enough: every clone has one, including a laptop
# that only checks the server from the outside.
ON_SERVER=0
if [ "$HAS_COMPOSE_FILE" = 1 ] && [ "$HAS_DOCKER" = 1 ] &&
  [ -n "$(docker compose -f "$COMPOSE_FILE_PATH" ps --all -q 2>/dev/null)" ]; then
  ON_SERVER=1
fi
NOT_SERVER_NOTE="this machine does not run the stack"

PASSED=0
FAILED=0
SKIPPED=0

pass() {
  printf 'PASS  %s\n' "$1"
  PASSED=$((PASSED + 1))
}

fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '      fix: %s\n' "$2"
  fi
  FAILED=$((FAILED + 1))
}

skip() {
  printf 'SKIP  %s\n' "$1"
  SKIPPED=$((SKIPPED + 1))
}

ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/selfhost-check.XXXXXX")
trap 'rm -f "$ERR_FILE"' EXIT

ccurl() {
  if [ "$INSECURE" = 1 ]; then
    curl -k "$@"
  else
    curl "$@"
  fi
}

# fetch <url> [curl args...] — sets RC, CODE, CTYPE, BODY and CURL_ERR.
fetch() {
  local url=$1 out meta
  shift
  out=$(ccurl -sS --max-time "$TIMEOUT" -w '\n%{http_code} %{content_type}' "$@" "$url" 2>"$ERR_FILE")
  RC=$?
  meta=${out##*$'\n'}
  BODY=${out%$'\n'*}
  [ "$meta" = "$out" ] && BODY=""
  CODE=${meta%% *}
  CTYPE=${meta#* }
  [ "$CTYPE" = "$meta" ] && CTYPE=""
  CURL_ERR=$(head -n 1 "$ERR_FILE" 2>/dev/null)
}

# One line explaining a curl transport failure, by exit code.
transport_hint() {
  case $1 in
    6) echo "the name does not resolve from here: check the DNS record" ;;
    7) echo "connection refused: open ports 80 and 443 (ufw and the cloud provider's firewall) and check that caddy is running" ;;
    28) echo "timed out: a firewall is probably dropping the traffic, often the cloud provider's firewall or security group" ;;
    35 | 51 | 58 | 60) echo "TLS failed: Caddy has no valid certificate yet, see the certificate check above" ;;
    52 | 56) echo "the connection closed with no answer: docker compose -f $COMPOSE_FILE_PATH logs --tail 50 caddy server" ;;
    *) echo "curl exit $1: ${CURL_ERR:-no detail}" ;;
  esac
}

# Hint for an HTTP status from the proxy.
status_hint() {
  case $1 in
    502 | 503 | 504) echo "the proxy cannot reach the container: docker compose -f $COMPOSE_FILE_PATH ps, then logs --tail 50 for the unhealthy service" ;;
    000) transport_hint "$RC" ;;
    *) echo "unexpected HTTP $1: docker compose -f $COMPOSE_FILE_PATH logs --tail 50 caddy server" ;;
  esac
}

is_ip_literal() {
  case $1 in
    *[!0-9.]*) ;;
    *) return 0 ;;
  esac
  case $1 in
    *:*) return 0 ;;
  esac
  return 1
}

# resolve <A|AAAA> — prints one address per line.
resolve() {
  if command -v dig >/dev/null 2>&1; then
    if [ "$1" = A ]; then
      dig +short "$DOMAIN" A | grep -E '^[0-9]+(\.[0-9]+){3}$'
    else
      dig +short "$DOMAIN" AAAA | grep ':'
    fi
  elif command -v getent >/dev/null 2>&1; then
    if [ "$1" = A ]; then
      getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u
    else
      getent ahostsv6 "$DOMAIN" | awk '{print $1}' | grep -v '^::ffff:' | sort -u
    fi
  elif command -v host >/dev/null 2>&1; then
    if [ "$1" = A ]; then
      host -t A "$DOMAIN" | awk '/has address/ {print $4}'
    else
      host -t AAAA "$DOMAIN" | awk '/has IPv6 address/ {print $5}'
    fi
  else
    return 2
  fi
}

public_ip() {
  local ip
  if [ "$1" = 4 ] && [ -n "${SELFHOST_PUBLIC_IP:-}" ]; then
    echo "$SELFHOST_PUBLIC_IP"
    return 0
  fi
  ip=$(curl "-$1" -fsS --max-time 5 https://ifconfig.me 2>/dev/null) || return 1
  # A proxy or a NAT64 path can answer an IPv6 request with an IPv4 address,
  # so the answer has to be of the family that was asked for.
  if [ "$1" = 4 ]; then
    echo "$ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || return 1
  else
    case $ip in
      *:*) ;;
      *) return 1 ;;
    esac
    case $ip in
      *[!0-9a-fA-F:]*) return 1 ;;
    esac
  fi
  echo "$ip"
}

echo "Track Your Time self-host check: $BASE"
echo

# ── 1. DNS ────────────────────────────────────────────────────────────────

case $DOMAIN in
  localhost | *.localhost)
    skip "DNS (local trial on $DOMAIN)"
    ;;
  *)
    if is_ip_literal "$DOMAIN"; then
      skip "DNS ($DOMAIN is an IP address)"
    else
      A_RECORDS=$(resolve A 2>/dev/null)
      RESOLVE_RC=$?
      if [ "$RESOLVE_RC" = 2 ]; then
        skip "DNS (no dig, getent or host installed: sudo apt-get install -y dnsutils)"
      elif [ -z "$A_RECORDS" ]; then
        fail "DNS: $DOMAIN has no A record" \
          "create an A record for $DOMAIN pointing at the server's public IPv4, then wait until dig +short $DOMAIN prints it"
      else
        A_LIST=$(echo "$A_RECORDS" | tr '\n' ' ' | sed 's/ $//')
        if [ "$ON_SERVER" = 1 ]; then
          MY_IP=$(public_ip 4)
          if [ -z "$MY_IP" ]; then
            pass "DNS: $DOMAIN resolves to $A_LIST"
            skip "DNS matches this machine (public IPv4 lookup failed, set SELFHOST_PUBLIC_IP to compare)"
          elif echo "$A_RECORDS" | grep -qx "$MY_IP"; then
            pass "DNS: $DOMAIN resolves to $A_LIST, this machine's public IPv4"
          else
            fail "DNS: $DOMAIN resolves to $A_LIST, but this machine's public IPv4 is $MY_IP" \
              "point the A record at $MY_IP. If your DNS provider proxies traffic, set the record to DNS only"
          fi
        else
          pass "DNS: $DOMAIN resolves to $A_LIST"
          skip "DNS matches this machine ($NOT_SERVER_NOTE)"
        fi
      fi

      if [ "$RESOLVE_RC" != 2 ]; then
        AAAA_RECORDS=$(resolve AAAA 2>/dev/null)
        if [ -z "$AAAA_RECORDS" ]; then
          skip "DNS AAAA (no AAAA record, the site is IPv4 only)"
        elif [ "$ON_SERVER" = 1 ]; then
          AAAA_LIST=$(echo "$AAAA_RECORDS" | tr '\n' ' ' | sed 's/ $//')
          MY_IP6=$(public_ip 6)
          if [ -z "$MY_IP6" ]; then
            fail "DNS AAAA: $DOMAIN has AAAA $AAAA_LIST, but this machine has no working public IPv6" \
              "delete the AAAA record, or enable IPv6 on the server: a wrong AAAA record can fail certificate issuance"
          elif echo "$AAAA_RECORDS" | grep -qix "$MY_IP6"; then
            pass "DNS AAAA: $DOMAIN resolves to $AAAA_LIST, this machine's public IPv6"
          else
            fail "DNS AAAA: $DOMAIN resolves to $AAAA_LIST, but this machine's public IPv6 is $MY_IP6" \
              "point the AAAA record at $MY_IP6, or delete it"
          fi
        else
          pass "DNS AAAA: $DOMAIN resolves to $(echo "$AAAA_RECORDS" | tr '\n' ' ' | sed 's/ $//')"
        fi
      fi
    fi
    ;;
esac

# ── 2. Containers ─────────────────────────────────────────────────────────

if [ "$HAS_COMPOSE_FILE" != 1 ]; then
  skip "containers (no $COMPOSE_FILE_PATH in $(pwd): run from the clone on the server)"
elif [ "$HAS_DOCKER" != 1 ]; then
  skip "containers (docker is not installed on this machine: run the check on the server)"
else
  if ! SERVICES=$(docker compose -f "$COMPOSE_FILE_PATH" config --services 2>"$ERR_FILE") || [ -z "$SERVICES" ]; then
    ERR_LINE=$(grep -v '^[[:space:]]*$' "$ERR_FILE" | head -n 1)
    case $ERR_LINE in
      *"permission denied"*)
        fail "containers: docker says permission denied" \
          "re-run with sudo, or add your user to the docker group: sudo usermod -aG docker \$USER, then log in again"
        ;;
      *"is not a docker command"* | *"unknown command"* | *"unknown shorthand flag"*)
        fail "containers: the Docker Compose plugin is missing" \
          "sudo apt-get install -y docker-compose-plugin"
        ;;
      *)
        fail "containers: docker compose cannot read $COMPOSE_FILE_PATH: ${ERR_LINE:-no detail}" \
          "run from the clone directory, and check that .env exists and sets APP_DOMAIN and BETTER_AUTH_SECRET"
        ;;
    esac
  else
    STATES=$(docker compose -f "$COMPOSE_FILE_PATH" ps --all --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null)
    TOTAL=0
    GOOD=0
    BAD=""
    for service in $SERVICES; do
      TOTAL=$((TOTAL + 1))
      line=$(echo "$STATES" | grep "^$service|" | head -n 1)
      state=$(echo "$line" | cut -d '|' -f 2)
      health=$(echo "$line" | cut -d '|' -f 3)
      if [ -z "$line" ]; then
        BAD="$BAD $service=not-created"
      elif [ "$state" = running ] && { [ "$health" = healthy ] || [ -z "$health" ]; }; then
        GOOD=$((GOOD + 1))
      else
        BAD="$BAD $service=$state${health:+/$health}"
      fi
    done
    ALL=$(echo "$SERVICES" | tr '\n' ' ' | sed 's/ $//')
    if [ -z "$STATES" ]; then
      fail "containers: none exist for $COMPOSE_FILE_PATH in $(pwd)" \
        "start the stack: docker compose -f $COMPOSE_FILE_PATH up -d"
    elif [ "$GOOD" = "$TOTAL" ]; then
      pass "containers: $GOOD/$TOTAL services running and healthy ($ALL)"
    else
      fail "containers: $GOOD/$TOTAL healthy, not ready:$BAD" \
        "wait a few minutes if a service is starting. Otherwise read docker compose -f $COMPOSE_FILE_PATH logs --tail 100 <service>"
    fi
  fi
fi

# ── 3. TLS and port 80 ────────────────────────────────────────────────────

if [ "$SCHEME" != https ]; then
  skip "HTTPS certificate ($BASE is plain http)"
else
  curl -sS -o /dev/null --max-time "$TIMEOUT" "$BASE/" 2>"$ERR_FILE"
  TLS_RC=$?
  CURL_ERR=$(head -n 1 "$ERR_FILE" 2>/dev/null)
  case $TLS_RC in
    0) pass "HTTPS certificate for $HOST is valid and trusted" ;;
    35 | 51 | 58 | 60)
      if [ "$INSECURE" = 1 ]; then
        skip "HTTPS certificate is not trusted, accepted because of --insecure"
      else
        fail "HTTPS certificate for $HOST is not trusted (curl exit $TLS_RC)" \
          "Caddy has no Let's Encrypt certificate yet: check DNS and port 80, then docker compose -f $COMPOSE_FILE_PATH logs caddy | grep -i -E 'acme|certificate|obtain'"
      fi
      ;;
    *) fail "HTTPS on $HOST: no answer (curl exit $TLS_RC)" "$(transport_hint "$TLS_RC")" ;;
  esac

  # Port 80 carries the ACME HTTP challenge, at issuance and at every renewal.
  # A local trial or a non-standard port has no ACME challenge to answer.
  case $HOST_NO_PORT in
    localhost | *.localhost) PORT80_SKIP="local trial on $HOST_NO_PORT" ;;
    *) PORT80_SKIP="" ;;
  esac
  if [ "$HOST" != "$HOST_NO_PORT" ]; then
    PORT80_SKIP="$BASE uses a non-standard port"
  elif is_ip_literal "$HOST_NO_PORT"; then
    PORT80_SKIP="$HOST_NO_PORT is an IP address"
  fi
  if [ -n "$PORT80_SKIP" ]; then
    skip "port 80 redirect ($PORT80_SKIP)"
  else
    fetch "http://$HOST_NO_PORT/" -o /dev/null
    case $CODE in
      301 | 302 | 307 | 308) pass "port 80 answers and redirects to HTTPS (HTTP $CODE)" ;;
      000)
        fail "port 80 on $HOST_NO_PORT does not answer" \
          "open 80/tcp in ufw and in the cloud provider's firewall: certificate issuance and renewal need it"
        ;;
      *) fail "port 80 answered HTTP $CODE instead of a redirect to HTTPS" \
        "check that nothing else listens on port 80 (sudo ss -tlnp | grep ':80 ') and that APP_DOMAIN matches $HOST_NO_PORT" ;;
    esac
  fi
fi

# ── 4. The API behind the proxy ───────────────────────────────────────────

fetch "$BASE/api/health"
if [ "$CODE" != 200 ]; then
  fail "GET /api/health answered HTTP $CODE" "$(status_hint "$CODE")"
elif ! printf '%s' "$BODY" | grep -q '"status":"ok"'; then
  case $CTYPE in
    *html*)
      fail "GET /api/health answered HTML: the request reached the web app, not the API" \
        "route /api/* to the server: the Caddyfile needs its handle /api/* { reverse_proxy server:5159 } block, and a proxy in front of Caddy must pass /api through"
      ;;
    *) fail "GET /api/health did not report status ok: $(printf '%s' "$BODY" | head -c 200)" \
      "docker compose -f $COMPOSE_FILE_PATH logs --tail 100 server" ;;
  esac
else
  pass "GET /api/health reports status ok"
  if printf '%s' "$BODY" | grep -q '"db":true'; then
    pass "GET /api/health reports db:true (MongoDB connected)"
  else
    fail "GET /api/health reports db:false (MongoDB not connected)" \
      "docker compose -f $COMPOSE_FILE_PATH logs --tail 100 mongo, then the same for server"
  fi
  WEB_URL=$(printf '%s' "$BODY" | sed -n 's/.*"webUrl":"\([^"]*\)".*/\1/p' | head -n 1)
  if [ "$WEB_URL" = "$BASE" ]; then
    pass "GET /api/health webUrl is $WEB_URL"
  else
    fail "GET /api/health webUrl is '$WEB_URL', expected '$BASE'" \
      "set APP_DOMAIN (or APP_URL) in .env to the exact address you type in the browser, then docker compose -f $COMPOSE_FILE_PATH up -d server"
  fi
fi

fetch "$BASE/" -o /dev/null
case $CODE:$CTYPE in
  200:*text/html*) pass "GET / serves the web app (200, text/html)" ;;
  200:*)
    fail "GET / answered 200 with '$CTYPE', not the web app's HTML" \
      "the Caddyfile's handle block without a path must proxy to client:8080"
    ;;
  *) fail "GET / answered HTTP $CODE" "$(status_hint "$CODE")" ;;
esac

fetch "$BASE/api/auth/get-session"
case $CODE:$CTYPE in
  200:*json*) pass "GET /api/auth/get-session answers JSON (sign-in is routed to the server)" ;;
  *:*html*)
    fail "GET /api/auth/get-session answered HTML (HTTP $CODE), not the API: /api does not reach the server" \
      "route /api/* to the server: the Caddyfile needs its handle /api/* { reverse_proxy server:5159 } block, and a proxy in front of Caddy must pass /api through, then docker compose -f $COMPOSE_FILE_PATH restart caddy"
    ;;
  *) fail "GET /api/auth/get-session answered HTTP $CODE ${CTYPE:+($CTYPE)}" "$(status_hint "$CODE")" ;;
esac

fetch "$BASE/api/v1/openapi.json" -o /dev/null
case $CODE:$CTYPE in
  200:*json*) pass "GET /api/v1/openapi.json answers JSON (the REST API is routed)" ;;
  *:*html*)
    fail "GET /api/v1/openapi.json answered HTML (HTTP $CODE), not the API" \
      "route /api/* to the server: the Caddyfile needs its handle /api/* { reverse_proxy server:5159 } block, and a proxy in front of Caddy must pass /api through"
    ;;
  *) fail "GET /api/v1/openapi.json answered HTTP $CODE ${CTYPE:+($CTYPE)}" "$(status_hint "$CODE")" ;;
esac

# The server answers an upgrade with no session 401 and destroys the socket.
# A 101 is also fine. Anything else means the upgrade never reached it intact:
# the web app's HTML, a 404, or a 502 from a proxy whose upstream dropped a
# rewritten path.
fetch "$BASE/ws" -o /dev/null --http1.1 --max-time 5 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dHJhY2t5b3VydGltZSBjaGs="
case $CODE in
  401) pass "WebSocket upgrade on /ws reaches the server (401 without a session, as expected)" ;;
  101) pass "WebSocket upgrade on /ws answers 101 Switching Protocols" ;;
  403)
    fail "WebSocket upgrade on /ws answered 403: the server refused the Origin" \
      "a proxy in front is adding an Origin header, or APP_URL does not match. The server logs the origin: docker compose -f $COMPOSE_FILE_PATH logs server | grep '\[ws\]'"
    ;;
  000 | 502)
    fail "WebSocket upgrade on /ws was dropped (HTTP $CODE)" \
      "proxy /ws to the server without rewriting the path: in Caddy use handle /ws, never handle_path"
    ;;
  *)
    fail "WebSocket upgrade on /ws answered HTTP $CODE, not the server" \
      "route /ws to the server: the Caddyfile needs its handle /ws { reverse_proxy server:5159 } block"
    ;;
esac

# ── 5. Optional: an API token ─────────────────────────────────────────────

if [ -z "$TOKEN" ]; then
  skip "API token (pass --token tt_... or set TRACKYOURTIME_API_TOKEN to check one)"
else
  fetch "$BASE/api/v1/me" -H "Authorization: Bearer $TOKEN"
  case $CODE in
    200)
      SCOPES=$(printf '%s' "$BODY" | sed -n 's/.*"scopes":\[\([^]]*\)\].*/\1/p' | tr -d '"' | sed 's/,/, /g')
      pass "GET /api/v1/me accepts the token, scopes: ${SCOPES:-none}"
      ;;
    401)
      fail "GET /api/v1/me rejected the token (401)" \
        "create a token in Settings → Integrations → New token on this instance and copy the whole value"
      ;;
    429)
      fail "GET /api/v1/me answered 429: too many requests" \
        "wait one minute, then run the check again"
      ;;
    *) fail "GET /api/v1/me answered HTTP $CODE" "$(status_hint "$CODE")" ;;
  esac
fi

echo
echo "$PASSED passed, $FAILED failed, $SKIPPED skipped"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
