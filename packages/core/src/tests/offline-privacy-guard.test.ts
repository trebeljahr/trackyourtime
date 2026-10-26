import assert from "node:assert/strict";
import { it } from "node:test";
import { createOfflineQueue } from "../offline-queue.js";
import { memoryStorage } from "../storage.js";
import { durableQueuedWrite } from "../durable-entry.js";
const server = "https://api.example.test";
it("checks new plaintext under queue ownership before enqueue/submit and never sends a refused row", async () => {
  const storage = memoryStorage(); let writes = 0, runs = 0, entered = false;
  const queue = createOfflineQueue({ storage: { ...storage, setItem: async (key, raw) => { writes++; await storage.setItem(key, raw); } }, exclusive: async (task) => { entered = true; try { return await task(); } finally { entered = false; } }, beforeContentWrite: async (row) => { assert.equal(entered, true); assert.equal(row.owner, "owner"); throw new Error("Private mode refuses plaintext"); } });
  await assert.rejects(queue.enqueue("entries.start", { input: { description: "Private work" } }, "owner", server, "workspace"), /refuses plaintext/);
  await assert.rejects(queue.submit("entries.start", { input: { description: "Private work" } }, { owner: "owner", server, workspaceId: "workspace" }, async () => { runs++; }), /refuses plaintext/);
  assert.equal(writes, 0); assert.equal(runs, 0); assert.deepEqual(await queue.list(), []);
});
it("preserves existing plaintext rows across refused replay, payload amendments and in-place repairs", async () => {
  const storage = memoryStorage(); let standard = true, sent = false;
  const queue = createOfflineQueue({ storage, key: "queue", beforeContentWrite: async () => { const check = () => { if (!standard) throw new Error("Private mode refuses plaintext"); }; check(); return check; } });
  await queue.enqueue("entries.start", { input: { description: "Old unsent work" } }, "owner", server, "workspace"); const raw = await storage.getItem("queue"); standard = false;
  await assert.rejects(queue.amendPayloads(() => ({ input: { description: "New private draft" } })), /refuses plaintext/); assert.equal(await storage.getItem("queue"), raw);
  await assert.rejects(queue.amendPayloads((row) => { (row.payload as { input: { description: string } }).input.description = "New in-place private draft"; return undefined; }), /refuses plaintext/); assert.equal(await storage.getItem("queue"), raw);
  await assert.rejects(queue.amendRows((rows) => { rows[0]!.payload = { input: { description: "New in-place private draft" } }; return [...rows]; }), /refuses plaintext/); assert.equal(await storage.getItem("queue"), raw);
  const result = await queue.flush(async () => { sent = true; }); assert.equal(result.remaining, 1); assert.match(String(result.error), /refuses plaintext/); assert.equal(sent, false); assert.equal(await storage.getItem("queue"), raw);
});
it("retains an earlier saved row when policy changes during persistence without freezing or sending it", async () => {
  const backing = memoryStorage(); let standard = true, sent = false, writes = 0;
  const queue = createOfflineQueue({ key: "queue", durableEntries: true, storage: { ...backing, setItem: async (key, raw) => { writes++; await backing.setItem(key, raw); standard = false; } }, beforeContentWrite: async () => () => { if (!standard) throw new Error("Private policy changed"); } });
  let failure;
  try { await queue.submit("entries.start", { input: { description: "Draft made in standard mode" } }, { owner: "owner", server, workspaceId: "workspace" }, async () => { sent = true; }); } catch (error) { failure = error; }
  assert.ok(durableQueuedWrite(failure)); assert.equal(writes, 1); assert.equal(sent, false);
  const rows = await queue.list(); assert.equal(rows.length, 1); assert.equal(rows[0]!.submittedInput, undefined);
});
