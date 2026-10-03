import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, Agent } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { closeHttpServer } from "../shutdown.js";

// Real keep-alive client and listener: a request accepted before close must
// complete, but returning its socket to a pool must not keep shutdown alive.
test("HTTP shutdown preserves accepted work and reaps the returned keep-alive socket", { timeout: 3_000 }, async (t) => {
  let accepted!: () => void;
  let finish!: () => void;
  const acceptedRequest = new Promise<void>((resolve) => { accepted = resolve; });
  const server = createServer((_req, res) => {
    accepted();
    finish = () => res.end("durable result");
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => { agent.destroy(); server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = new Promise<string>((resolve, reject) => {
    request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", (data: string) => { body += data; });
      res.on("end", () => resolve(body)); res.on("error", reject);
    }).on("error", reject).end();
  });
  await acceptedRequest;
  let closed = false;
  const closing = closeHttpServer(server).then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false, "close cannot drop an active request");
  finish();
  assert.equal(await response, "durable result");
  await closing;
  assert.equal(server.listening, false);
});
