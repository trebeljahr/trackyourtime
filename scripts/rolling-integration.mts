/** Isolated, synthetic two-replica proof. Never reads project dotenv files or live credentials.
 * Run: node --import tsx scripts/rolling-integration.mts
 * Requires local mongod and an already-present redis:7-alpine Docker image. */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { MongoClient } from "mongodb";
import { createSyncClient } from "../packages/core/src/sync-client.js";
import { createSyncClient as raycastSyncClient } from "../packages/raycast/src/vendor/core/sync-client.js";
const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const { WebSocket } = require("ws");
const root = resolve(import.meta.dirname, "..");
if (existsSync(join(root, "packages/server/.env.development"))) throw new Error("Run the proof in an isolated checkout without a server dotenv file");
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => Promise<boolean> | boolean, label: string, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (asyncFailure) throw asyncFailure; if (await check()) return; await wait(75); }
  throw new Error(`Proof deadline: ${label}`);
}
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = randomInt(49152, 65536), probe = createNetServer();
    try { await new Promise<void>((ok, bad) => { probe.once("error", bad); probe.listen(port, "127.0.0.1", ok); }); }
    catch { if (attempt === 2) throw new Error("No free proof port"); continue; }
    await new Promise<void>((done) => probe.close(() => done())); return port;
  }
  throw new Error("No free proof port");
}
function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Owned Redis command failed: ${args[0]}`);
  return result.stdout.trim();
}
const temp = await mkdtemp(join(tmpdir(), "track-rolling-proof-"));
const children: ChildProcess[] = [], handles: Awaited<ReturnType<typeof open>>[] = [];
let asyncFailure: unknown;
const syncClients: { close(): void }[] = [], rawSockets: InstanceType<typeof WebSocket>[] = [];
const proxySockets = new Set<import("node:net").Socket>();
let mongo: MongoClient | undefined, redisCreated = false, observing = false, observation: Promise<void> | undefined;
let proxy: ReturnType<typeof createServer> | undefined;
const redisName = `track-rolling-proof-${randomUUID().slice(0, 8)}`;
const report = { crossReplica: false, roomIsolation: false, droppedResponseReplay: false,
  redisOutageRecovery: false, drainReconnect: false, acceptedRequestCompleted: false,
  schedulerLeaseShared: false, nativeCore: false, raycastVendoredCore: false,
  httpSamples: 0, unexpectedHttpFailures: 0, snapshots: 0, redisRecoveredMs: 0, shutdownMs: 0 };
async function child(label: string, command: string, args: string[], env?: Record<string, string>): Promise<ChildProcess> {
  const log = await open(join(temp, `${label}.log`), "w", 0o600); handles.push(log);
  const p = spawn(command, args, { cwd: root, env: env ?? process.env, stdio: ["ignore", log.fd, log.fd] });
  children.push(p); return p;
}
try {
  const mongoPort = await freePort(), redisPort = await freePort(), aPort = await freePort(), bPort = await freePort(), proxyPort = await freePort();
  await mkdir(join(temp, "mongo"));
  const mongoProcess = await child("mongo", process.env.MONGOD_BINARY ?? "/opt/homebrew/bin/mongod", ["--dbpath", join(temp, "mongo"), "--bind_ip", "127.0.0.1", "--port", String(mongoPort), "--replSet", "proof", "--wiredTigerCacheSizeGB", "0.25"]);
  mongo = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, { serverSelectionTimeoutMS: 1000 });
  await until(async () => { try { await mongo!.connect(); return true; } catch { assert.equal(mongoProcess.exitCode, null); return false; } }, "Mongo startup");
  await mongo.db("admin").command({ replSetInitiate: { _id: "proof", members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
  await until(async () => !!(await mongo!.db("admin").command({ hello: 1 })).isWritablePrimary, "replica-set election");
  docker(["run", "--detach", "--name", redisName, "--memory", "64m", "--cpus", "0.25", "--publish", `127.0.0.1:${redisPort}:6379`, "redis:7-alpine", "redis-server", "--save", "", "--appendonly", "no"]); redisCreated = true;
  let target = aPort, dropNextCreateReply = false;
  proxy = createServer((req, res) => {
    const dropReply = dropNextCreateReply && req.url?.startsWith("/api/trpc/entries.applyOperation");
    if (dropReply) dropNextCreateReply = false;
    const upstream = request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (reply) => { if (dropReply) { reply.resume(); res.destroy(); return; } res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res); });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.on("connection", (socket) => { proxySockets.add(socket); socket.once("close", () => proxySockets.delete(socket)); });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = createConnection(target, "127.0.0.1", () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => proxy!.listen(proxyPort, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${proxyPort}`, directA = `http://127.0.0.1:${aPort}`, directB = `http://127.0.0.1:${bPort}`;
  // Explicit environment: no external mail/analytics/provider credentials inherited.
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: temp,
    NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=384", EMAIL_TRANSPORT: "none",
    MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}/rolling-proof?replicaSet=proof`, REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    BETTER_AUTH_SECRET: "rolling-proof-synthetic-auth-secret-00000000000000000000000000", BETTER_AUTH_URL: origin,
    FRONTEND_URL: origin, TRUSTED_ORIGINS: `${origin},app://-,capacitor://localhost`,
    SCHEDULER_ENABLED: "true", TRACK_ROLLING_PROOF_FIXTURE: "isolated", TRACKYOURTIME_UPDATE_CHECK: "false", HATCHKIT_KEYCHAIN_ACCESS: "deny" };
  const healthy = async (url: string): Promise<boolean> => { try { const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) }); const body = await r.json(); return r.ok && body.rollingReady && body.capabilities?.durableEntryReplay; } catch { return false; } };
  const a = await child("server-a", process.execPath, ["--import", "tsx", "--import", "./scripts/fixtures/rolling-scheduler.mts", "packages/server/src/index.ts"], { ...env, PORT: String(aPort) });
  await until(() => healthy(directA), "replica A readiness", 30_000);
  const b = await child("server-b", process.execPath, ["--import", "tsx", "--import", "./scripts/fixtures/rolling-scheduler.mts", "packages/server/src/index.ts"], { ...env, PORT: String(bPort) });
  await until(() => healthy(directB), "replica B readiness", 30_000);
  async function account(label: string): Promise<{ token: string; userId: string; workspaceId: string }> {
    const response = await fetch(`${origin}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: `${label}-${randomUUID()}@example.test`, password: "Synthetic-Proof-Password-729!", name: label }) });
    assert.equal(response.status, 200, "synthetic signup"); const data = await response.json();
    const token = response.headers.get("set-auth-token") ?? data.token; assert.ok(token);
    const workspaces = await call(token, "workspaces.list", {}, false);
    assert.ok(workspaces[0]?.id); return { token, userId: data.user.id, workspaceId: workspaces[0].id };
  }
  async function call(token: string, method: string, input: unknown, mutation = true, server = origin): Promise<any> {
    if (mutation && method.startsWith("entries.") && method !== "entries.applyOperation" && (input as any)?.operationId) {
      const { operationId, workspaceId, ...payload } = input as any;
      input = { operation: method, operationId, workspaceId, input: payload }; method = "entries.applyOperation";
    }
    const response = await fetch(`${server}/api/trpc/${method}${mutation ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
      method: mutation ? "POST" : "GET", headers: { "content-type": "application/json", origin, authorization: `Bearer ${token}` },
      ...(mutation ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `${method} status`); const payload = await response.json(); return payload.result.data;
  }
  const owner = await account("Owner"), outsider = await account("Other");
  await new Promise<void>((done, fail) => {
    const socket = new WebSocket(origin.replace("http", "ws") + "/ws"); rawSockets.push(socket);
    socket.once("unexpected-response", (_request: unknown, response: { statusCode: number; resume(): void }) => {
      response.resume(); socket.terminate();
      try { assert.equal(response.statusCode, 401); done(); } catch (error) { fail(error); }
    });
    socket.once("open", () => fail(new Error("Unauthenticated socket was accepted"))); socket.on("error", () => {});
  });
  const events: any[][] = [[], [], []], opens = [0, 0, 0], snapshots: any[][] = [[], []];
  for (let i = 0; i < 3; i++) {
    const identity = i === 2 ? outsider : owner;
    const factory = i === 1 ? raycastSyncClient : createSyncClient;
    const client = factory({ url: origin.replace("http", "ws") + `/ws?roomId=user:${owner.userId}`, token: identity.token,
      minBackoffMs: 40, maxBackoffMs: 150, onEvent: (event) => events[i]!.push(event),
      onStatus: (status) => { if (status === "open") opens[i]! += 1; },
      onSyncState: (distributed) => { if (distributed && i < 2) void call(identity.token, "entries.list", { workspaceId: identity.workspaceId, from: "2026-01-01", to: "2027-01-01" }, false).then((result) => { snapshots[i] = result.entries; report.snapshots++; }).catch((error) => { asyncFailure = error; }); },
    }); syncClients.push(client); client.connect();
  }
  await until(() => opens.every((n) => n > 0) && report.snapshots >= 2, "authenticated core and vendored clients");
  // A malicious room claim never changes the authenticated recipient.
  const malicious = new WebSocket(origin.replace("http", "ws") + `/ws?roomId=user:${owner.userId}`, [`bearer.${encodeURIComponent(outsider.token)}`]); rawSockets.push(malicious);
  const leaks: any[] = []; malicious.on("message", (raw: Buffer) => { const value = JSON.parse(String(raw)); if (value.type === "tt:sync") leaks.push(value); });
  await new Promise<void>((done, fail) => { malicious.once("open", done); malicious.once("error", fail); }); malicious.send(JSON.stringify({ type: "join-room", roomId: `user:${owner.userId}` }));
  const requestInput = { operationId: randomUUID(), workspaceId: owner.workspaceId, description: "Cross-replica retained", start: new Date(Date.now() - 60_000).toISOString(), end: new Date().toISOString() };
  const written = await call(owner.token, "entries.create", requestInput, true, directB);
  await until(() => events[0]!.some((e) => e.entry?.id === written.id) && events[1]!.some((e) => e.entry?.id === written.id), "B fanout to A sockets"); report.crossReplica = true;
  // Drop a new operation's committed HTTP reply at the proxy, then retry on A.
  target = bPort; dropNextCreateReply = true;
  const droppedInput = { ...requestInput, operationId: randomUUID(), description: "Lost committed response" };
  await assert.rejects(call(owner.token, "entries.create", droppedInput));
  const retried = await call(owner.token, "entries.create", droppedInput, true, directA);
  const durable = await mongo.db("rolling-proof").collection("timeentries").find({ description: droppedInput.description }).toArray();
  assert.equal(durable.length, 1); assert.equal(String(durable[0]!._id), retried.id); report.droppedResponseReplay = true;
  target = aPort;
  assert.equal(events[2]!.length, 0); assert.equal(leaks.length, 0); report.roomIsolation = true;
  const beforeGap = [...opens]; docker(["stop", "--time", "1", redisName]);
  await until(async () => !(await healthy(directA)) && !(await healthy(directB)), "readiness rejects Redis outage");
  const missed = await call(owner.token, "entries.create", { ...requestInput, operationId: randomUUID(), description: "Durable during Redis gap" }, true, directB);
  const restartedAt = Date.now(); docker(["start", redisName]);
  await until(() => healthy(directA), "Redis recovery A"); await until(() => healthy(directB), "Redis recovery B");
  await until(() => opens[0]! > beforeGap[0]! && opens[1]! > beforeGap[1]! && snapshots.every((rows) => rows.some((row) => row.id === missed.id)), "authoritative snapshots after reconnect");
  report.redisOutageRecovery = true; report.redisRecoveredMs = Date.now() - restartedAt;
  const jobs = await mongo.db("rolling-proof").collection("scheduledjobs").find({}, { projection: { name: 1, lastRunAt: 1 } }).toArray();
  assert.ok(jobs.length >= 2); assert.equal(new Set(jobs.map((j) => j.name)).size, jobs.length); assert.ok(jobs.every((j) => j.lastRunAt));
  target = bPort; observing = true;
  observation = (async () => { while (observing) { try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) }); report.httpSamples++; if (response.status !== 200) report.unexpectedHttpFailures++; } catch { report.unexpectedHttpFailures++; } await wait(100); } })();
  const beforeDrain = [...opens], drainStarted = Date.now();
  // A body already accepted by the old process is completed while draining.
  const body = JSON.stringify({ ...requestInput, operationId: randomUUID(), description: "Accepted before drain" });
  const accepted = new Promise<number>((done, fail) => {
    const slow = request(`${directA}/api/trpc/entries.create`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), origin, authorization: `Bearer ${owner.token}` } }, (response) => { response.resume(); response.once("end", () => done(response.statusCode!)); });
    slow.on("error", fail); slow.write(body.slice(0, 20)); setTimeout(() => slow.end(body.slice(20)), 3000);
  });
  await wait(150); a.kill("SIGTERM");
  await until(async () => !(await healthy(directA)), "draining readiness"); assert.equal(await accepted, 200); report.acceptedRequestCompleted = true;
  await until(() => a.exitCode !== null, "graceful replica exit", 28_000); assert.equal(a.exitCode, 0);
  await until(() => opens[0]! > beforeDrain[0]! && opens[1]! > beforeDrain[1]!, "clients follow replacement");
  report.shutdownMs = Date.now() - drainStarted; report.drainReconnect = true;
  await until(async () => (await mongo!.db("rolling-proof").collection("rollingproofjobs").findOne({ _id: "singleton" as any }))?.processes?.length === 2, "scheduler handoff to surviving process");
  const ownership = await mongo.db("rolling-proof").collection("rollingproofjobs").findOne({ _id: "singleton" as any });
  assert.equal(ownership?.maximumActive, 1); assert.ok(ownership!.completed >= 1); report.schedulerLeaseShared = true;
  report.nativeCore = true; report.raycastVendoredCore = true;
  observing = false; await observation; assert.equal(report.unexpectedHttpFailures, 0); assert.equal(leaks.length, 0); assert.equal(events[2]!.length, 0);
  console.log(JSON.stringify({ passed: true, ...report, nativeShellRuntime: "not exercised", raycastHostRuntime: "not exercised" }, null, 2));
} finally {
  observing = false; await observation;
  for (const client of syncClients) client.close(); for (const socket of rawSockets) socket.terminate();
  for (const socket of proxySockets) socket.destroy(); if (proxy) await new Promise<void>((done) => proxy!.close(() => done()));
  for (const process of children.slice(1)) if (process.exitCode === null) process.kill("SIGTERM");
  for (const process of children.slice(1)) if (process.exitCode === null) { const deadline = Date.now() + 29_000; while (process.exitCode === null && Date.now() < deadline) await wait(100); if (process.exitCode === null) process.kill("SIGKILL"); }
  await mongo?.close(); asyncFailure = undefined;
  const databaseProcess = children[0]; if (databaseProcess?.exitCode === null) { databaseProcess.kill("SIGTERM"); await until(() => databaseProcess.exitCode !== null, "database cleanup"); }
  if (redisCreated) docker(["rm", "--force", redisName]);
  for (const handle of handles) await handle.close(); await rm(temp, { recursive: true, force: true });
}
