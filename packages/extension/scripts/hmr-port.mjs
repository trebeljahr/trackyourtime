import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

const MIN_PORT = 49152;
const MAX_PORT = 65535;

/** Whether nothing listens on `port` on loopback. */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function readStoredPort(file) {
  try {
    const port = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : null;
  } catch {
    return null;
  }
}

/**
 * The loaded dev extension imports its worker from a fixed dev-server port, so
 * a new port per restart leaves it fetching from a dead server (refused
 * WebSocket, "Failed to fetch") until someone reloads it. Reuse the last port
 * when it is still free; otherwise pick a random high one and remember it.
 */
export async function pickHmrPort(file, { isFree = isPortFree, random = () => randomInt(MIN_PORT, MAX_PORT + 1) } = {}) {
  const stored = readStoredPort(file);
  if (stored !== null && (await isFree(stored))) return stored;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = random();
    if (await isFree(port)) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${port}\n`);
      } catch {
        // Remembering the port is a convenience; a read-only checkout still runs.
      }
      return port;
    }
  }
  throw new Error("Could not find a free extension HMR port after three attempts.");
}
