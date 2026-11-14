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
# Open files: Docker's default soft limit is 1024, and mongod needs a file
# per collection and per index plus one per connection. The server unit suite
# makes a database per test file, and under load (2026-11-14, load average
# ~70) WiredTiger hit EMFILE and panicked (exit 133). 64000 is the limit
# MongoDB's production notes ask for. It is far below the daemon's own hard
# limit (1048576 in Colima and on GitHub's runners), which a container's
# limit may not exceed.
#
# Idempotent: a running container is reused, a stopped one is started, and a
# member whose set config is gone (a tmpfs data dir) is initiated again.
#
# A container made with other flags (an older version of this script, or
# other caller args) is recreated, because `docker start` keeps the flags it
# was created with. The flags are recorded in a label. Other sessions share a
# local container by name, so one with clients connected is never removed:
# this waits about 10 s for it to go idle, then reuses it as it is and warns.
# Short, because Playwright gives e2e/start-server.sh a fixed timeout; the
# next run tries again.
set -euo pipefail

name="$1"
port="$2"
shift 2

image="mongo:7"
run_args=(-p "$port:$port" --ulimit nofile=64000:64000 "$@")
config_label="trackyourtime.mongo-rs.config"
config="$image ${run_args[*]}"

shell() {
  docker exec "$name" mongosh --quiet "mongodb://127.0.0.1:$port/?directConnection=true" --eval "$1"
}

wait_for_ping() {
  for _ in $(seq 1 60); do
    shell 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1 && return 0
    sleep 1
  done
}

# Client connections other than mongosh's own (this script's, or a person's
# shell): an e2e server, a unit test file or a driver of another session.
# `connections.current` would also count mongosh's monitoring sockets, so
# this lists them. No answer counts as busy.
other_clients() {
  shell 'db.getSiblingDB("admin").aggregate([
    { $currentOp: { allUsers: true, idleConnections: true } },
    { $match: { client: { $exists: true }, appName: { $not: /^mongosh/ } } },
    { $count: "n" },
  ]).toArray().concat([{ n: 0 }])[0].n' 2>/dev/null || echo 1
}

exists() {
  docker ps -a --format '{{.Names}}' | grep -qx "$name"
}

if exists; then
  current="$(docker inspect --format "{{ index .Config.Labels \"$config_label\" }}" "$name" 2>/dev/null || true)"
  if [ "$current" != "$config" ]; then
    stale=1
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" = "true" ]; then
      wait_for_ping
      for _ in $(seq 1 10); do
        if [ "$(other_clients)" -le 0 ]; then stale=0; break; fi
        sleep 1
      done
    else
      stale=0
    fi
    if [ "$stale" = 1 ]; then
      echo "[mongo] $name has old flags but is in use; reusing it as it is" >&2
    else
      echo "[mongo] Recreating $name with new flags"
      # -v also drops the anonymous volumes (data dir, configdb) it made.
      docker rm -f -v "$name" >/dev/null
    fi
  fi
fi

if docker ps --format '{{.Names}}' | grep -qx "$name"; then
  :
elif exists; then
  docker start "$name" >/dev/null
elif ! docker run -d --name "$name" --label "$config_label=$config" "${run_args[@]}" "$image" \
    mongod --replSet rs --bind_ip_all --port "$port" >/dev/null; then
  # Another session created it between the check and this run.
  exists || exit 1
  docker start "$name" >/dev/null
fi

wait_for_ping

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
