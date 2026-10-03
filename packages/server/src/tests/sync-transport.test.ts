import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Redis } from "ioredis";
import type { ServerToClientMessage } from "@starter/shared";
import { SyncTransport, syncNamespace } from "../ws/sync-transport.js";

type Message = Extract<ServerToClientMessage, { type: "tt:sync" }>;
class Broker {
  available = true;
  clients: Connection[] = [];
  connection() { const c = new Connection(this); this.clients.push(c); return c; }
}
class Connection extends EventEmitter {
  status = "wait";
  channel = "";
  failPublish = false;
  subscribeBarrier: Promise<void> | null = null;
  constructor(readonly broker: Broker) { super(); }
  duplicate(options: Record<string, unknown>) {
    assert.equal(options.enableOfflineQueue, false, "outage events must never be queued");
    assert.equal(options.autoResendUnfulfilledCommands, false, "unacknowledged events must never replay");
    return this.broker.connection();
  }
  async connect() {
    if (!this.broker.available) { this.disconnect(); throw new Error("Redis unavailable"); }
    this.status = "ready"; this.emit("ready");
  }
  async subscribe(channel: string) { this.channel = channel; await this.subscribeBarrier; }
  async publish(channel: string, message: string) {
    if (this.failPublish) throw new Error("lost Redis");
    for (const client of this.broker.clients) {
      if (client.status === "ready" && client.channel === channel) client.emit("message", channel, message);
    }
    return 1;
  }
  disconnect() { this.status = "close"; this.channel = ""; this.emit("close"); }
}
const tick = () => new Promise<void>((done) => setImmediate(done));
const event: Message = { type: "tt:sync", event: { kind: "entry.deleted", id: "entry" }, workspaceId: "ws-a", originId: "tab-a" };

async function replicas() {
  const broker = new Broker();
  const receivedA: [string, Message][] = [];
  const receivedB: [string, Message][] = [];
  const resyncs = { a: 0, b: 0 };
  const a = new SyncTransport((user, message) => receivedA.push([user, message]), "database-a", () => { resyncs.a += 1; });
  const b = new SyncTransport((user, message) => receivedB.push([user, message]), "database-a", () => { resyncs.b += 1; });
  const root = broker.connection() as unknown as Redis;
  await a.start(root); await b.start(root); await tick();
  return { broker, a, b, receivedA, receivedB, resyncs };
}

test("two replicas deliver once locally and remotely, preserving recipient, workspace and origin", async () => {
  const { a, b, receivedA, receivedB } = await replicas();
  try {
    assert.equal(a.healthy(), true); assert.equal(b.healthy(), true);
    a.publish("only-this-user", event); await tick();
    assert.deepEqual(receivedA, [["only-this-user", event]]);
    assert.deepEqual(receivedB, receivedA);
    b.publish("removed-user", { type: "tt:sync", event: { kind: "membership.changed", workspaceId: "ws-a", reason: "removed" }, workspaceId: "ws-a" });
    await tick();
    assert.equal(receivedA[1]?.[0], "removed-user", "direct revocation reaches the other replica");
  } finally { a.stop(); b.stop(); }
});

test("subscriber disconnect degrades health, drops missed events, then resubscribes", async () => {
  const { broker, a, b, receivedA, receivedB } = await replicas();
  try {
    const subscriberB = broker.clients[4]!;
    subscriberB.disconnect(); assert.equal(b.healthy(), false);
    a.publish("user", event); await tick();
    assert.equal(receivedA.length, 1); assert.equal(receivedB.length, 0);
    await subscriberB.connect(); await tick();
    assert.equal(b.healthy(), true);
    assert.equal(receivedB.length, 0, "pub/sub does not replay missed events; clients must reconcile");
    a.publish("user", event); await tick(); assert.equal(receivedB.length, 1);
  } finally { a.stop(); b.stop(); }
});

test("publisher failure keeps local delivery and cannot queue a stale projected payload", async () => {
  const { broker, a, b, receivedA, receivedB } = await replicas();
  try {
    broker.clients[1]!.failPublish = true;
    a.publish("user", event); await tick();
    assert.equal(a.healthy(), false); assert.equal(receivedA.length, 1); assert.equal(receivedB.length, 0);
    a.publish("user", event); await tick(); assert.equal(receivedA.length, 2);
    broker.clients[1]!.failPublish = false;
    await broker.clients[1]!.connect(); await tick();
    assert.equal(a.healthy(), true); assert.equal(receivedB.length, 0);
    a.publish("user", event); await tick(); assert.equal(receivedB.length, 1);
  } finally { a.stop(); b.stop(); }
});

test("malformed or unrelated packets and shutdown never deliver", async () => {
  const { broker, a, b, receivedB } = await replicas();
  const subscriberB = broker.clients[4]!;
  const channel = subscriberB.channel;
  subscriberB.emit("message", channel, "garbage");
  subscriberB.emit("message", channel, JSON.stringify({ userId: "user", message: {} }));
  subscriberB.emit("message", "other-app", JSON.stringify({ userId: "user", message: event }));
  b.stop(); a.publish("user", event); await tick();
  assert.equal(b.healthy(), false); assert.equal(receivedB.length, 0); a.stop();
});

test("shared Redis keeps distinct databases isolated, independent of database credentials", async () => {
  assert.equal(syncNamespace("mongodb://old:password@host/app?retryWrites=true"), syncNamespace("mongodb://new:secret@host/app"));
  assert.notEqual(syncNamespace("mongodb://host/app"), syncNamespace("mongodb://host/other"));
  const { broker, a, b } = await replicas();
  const received: Message[] = [];
  const other = new SyncTransport((_user, message) => received.push(message), "database-b");
  try {
    await other.start(broker.connection() as unknown as Redis); await tick();
    a.publish("same-user-id", event); await tick(); assert.deepEqual(received, []);
  } finally { a.stop(); b.stop(); other.stop(); }
});

test("Redis unavailable at startup retains local delivery and can recover", async () => {
  const broker = new Broker(); broker.available = false;
  const received: Message[] = [];
  const transport = new SyncTransport((_user, message) => received.push(message), "database-a");
  try {
    await transport.start(broker.connection() as unknown as Redis);
    assert.equal(transport.healthy(), false);
    transport.publish("user", event); assert.deepEqual(received, [event]);
    broker.available = true;
    await broker.clients[1]!.connect(); await broker.clients[2]!.connect(); await tick();
    assert.equal(transport.healthy(), true);
  } finally { transport.stop(); }
});


test("a publisher-only gap forces local and healthy peer snapshots without waiting for a heartbeat", async () => {
  const { broker, a, b, receivedB, resyncs } = await replicas();
  try {
    broker.clients[1]!.disconnect();
    assert.equal(a.healthy(), false);
    assert.equal(b.healthy(), true);
    assert.deepEqual(resyncs, { a: 1, b: 0 });
    a.publish("user", event);
    await broker.clients[1]!.connect(); await tick();
    assert.equal(a.healthy(), true);
    assert.deepEqual(receivedB, [], "missed payloads cannot be replayed after authorization changes");
    assert.deepEqual(resyncs, { a: 2, b: 1 }, "recovery refreshes clients on both sides, including healthy peers");
  } finally { a.stop(); b.stop(); }
});

test("publish rejection recovers through a peer resync even without a socket close event", async () => {
  const { broker, a, b, resyncs } = await replicas();
  try {
    broker.clients[1]!.failPublish = true;
    a.publish("user", event); await tick();
    assert.equal(a.healthy(), false);
    assert.equal(resyncs.a, 1);
    broker.clients[1]!.failPublish = false;
    await broker.clients[1]!.connect(); await tick();
    assert.deepEqual(resyncs, { a: 2, b: 1 });
  } finally { a.stop(); b.stop(); }
});

test("stale subscribe acknowledgments cannot restore health and shutdown cancels recovery", async () => {
  const { broker, a, b, resyncs } = await replicas();
  try {
    const subscriber = broker.clients[2]!;
    subscriber.disconnect();
    let releaseOld!: () => void;
    subscriber.subscribeBarrier = new Promise<void>((resolve) => { releaseOld = resolve; });
    await subscriber.connect();
    subscriber.disconnect();
    let releaseNew!: () => void;
    subscriber.subscribeBarrier = new Promise<void>((resolve) => { releaseNew = resolve; });
    await subscriber.connect();
    releaseOld(); await tick();
    assert.equal(a.healthy(), false, "old connection acknowledgment cannot certify the new subscription");
    a.stop();
    releaseNew(); await tick();
    assert.equal(a.healthy(), false);
    assert.equal(resyncs.b, 0, "stopped transports cannot ask peers to reconnect");
  } finally { a.stop(); b.stop(); }
});
