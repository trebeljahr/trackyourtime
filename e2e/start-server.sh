#!/usr/bin/env bash
set -euo pipefail

# In CI, GitHub Actions services provide MongoDB/Redis. The app stores no
# objects, so no S3 container is started here or in CI.
# Locally, spin up Docker containers for E2E testing.

# Start a container, reusing an existing one of that name.
#
# Checking `docker ps` alone only sees RUNNING containers, so a container left
# behind by an earlier run (exited, not removed) was invisible here and the
# `docker run` below then failed with "Conflict. The container name is already
# in use", taking the whole suite down before a single test ran.
ensure_container() {
  local name="$1"
  shift

  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    return 0
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "[e2e] Reusing existing container $name"
    docker start "$name" >/dev/null
    return 0
  fi

  docker run -d --name "$name" "$@" >/dev/null
  echo "[e2e] Started $name"
}

if [ -z "${CI:-}" ]; then
  echo "[e2e] Starting local test infrastructure..."

  # MongoDB on port 27018
  ensure_container starter-e2e-mongo -p 27018:27017 --tmpfs /data/db mongo:7

  # Redis on port 6380
  ensure_container starter-e2e-redis -p 6380:6379 --tmpfs /data redis:7-alpine

  # Wait for MongoDB
  for i in $(seq 1 30); do
    node -e "
      const { MongoClient } = require('mongodb');
      MongoClient.connect('mongodb://127.0.0.1:27018')
        .then(c => { c.close(); process.exit(0); })
        .catch(() => process.exit(1));
    " 2>/dev/null && break
    sleep 1
  done
  echo "[e2e] MongoDB ready"

  # Wait for Redis
  for i in $(seq 1 10); do
    docker exec starter-e2e-redis redis-cli ping 2>/dev/null | grep -q PONG && break
    sleep 1
  done
  echo "[e2e] Redis ready"
fi

echo "[e2e] Starting server..."
exec pnpm --filter @starter/server run dev
