import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { setupWebSocket } from "../ws/handler.js";
import { setDraining } from "../readiness.js";
import type { UpgradeAuth } from "../ws/auth.js";

test("authentication started before drain cannot open a new WebSocket after drain begins", { timeout: 3_000 }, async (t) => {
  let authenticating!: () => void;
  let finishAuth!: (auth: UpgradeAuth) => void;
  const entered = new Promise<void>((resolve) => { authenticating = resolve; });
  const server = createServer();
  const wss = setupWebSocket(server, {
    authenticate: () => { authenticating(); return new Promise((resolve) => { finishAuth = resolve; }); },
    probe: async () => "live",
    enforceRunaway: async () => undefined,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`);
  ws.on("error", () => {});
  t.after(() => { ws.terminate(); wss.close(); server.close(); });
  const refused = new Promise<number | undefined>((resolve) => {
    ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode); res.resume(); });
  });
  await entered;
  setDraining();
  finishAuth({ session: { user: { id: "synthetic-user" } }, headers: new Headers() } as unknown as UpgradeAuth);
  assert.equal(await refused, 503);
  assert.equal(wss.clients.size, 0);
});
