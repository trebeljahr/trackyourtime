#!/usr/bin/env bash
# Ensure a throwaway single-node MongoDB replica set runs in Docker.
#
#   scripts/mongo-replica-set-container.sh <container-name> <host-port> [docker run args…]
#
# Used by CI's e2e and desktop jobs and by e2e/start-server.sh locally. The
# durable entry writes (API level 12, `entries.applyOperation`) commit their
# receipt and the entry change in one transaction, and a standalone mongod
# refuses them with 412 DURABLE_REPLAY_REQUIRES_REPLICA_SET. The web app and
# the desktop app send every entry write that way, so against a standalone
# database each new entry stays on its optimistic `temp-` id.
#
# A GitHub Actions service container cannot take mongod arguments, hence a
# script. mongod listens on the host port INSIDE the container too, and the
# member is named 127.0.0.1:<host-port>: a driver that discovers the set then
# reaches the member at the address the caller uses, with no
# `directConnection` or `replicaSet` in MONGODB_URI.
#
# Idempotent: a running container is reused, a stopped one is started, and a
# member whose set config is gone (a tmpfs data dir) is initiated again.
set -euo pipefail

name="$1"
port="$2"
shift 2

if docker ps --format '{{.Names}}' | grep -qx "$name"; then
  :
elif docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
  docker start "$name" >/dev/null
else
  docker run -d --name "$name" -p "$port:$port" "$@" mongo:7 \
    mongod --replSet rs --bind_ip_all --port "$port" >/dev/null
fi

shell() {
  docker exec "$name" mongosh --quiet "mongodb://127.0.0.1:$port/?directConnection=true" --eval "$1"
}

for _ in $(seq 1 60); do
  shell 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1 && break
  sleep 1
done

# rs.initiate refuses an initiated set, so ask first: `hello.setName` is only
# present once the member has a set config.
if [ "$(shell 'String(Boolean(db.hello().setName))' 2>/dev/null)" != "true" ]; then
  shell "rs.initiate({ _id: 'rs', members: [{ _id: 0, host: '127.0.0.1:$port' }] })" >/dev/null
fi

for _ in $(seq 1 60); do
  if [ "$(shell 'String(db.hello().isWritablePrimary)' 2>/dev/null)" = "true" ]; then
    echo "[mongo] $name is a single-node replica set on 127.0.0.1:$port"
    exit 0
  fi
  sleep 1
done

echo "[mongo] $name never became primary" >&2
docker logs "$name" 2>&1 | tail -40 >&2
exit 1
