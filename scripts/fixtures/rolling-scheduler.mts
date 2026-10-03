/** Loaded only by scripts/rolling-integration.mts, never by the application image. */
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { registerRecurringJob } from "../../packages/server/src/services/scheduler/registry.js";
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const mongoose = require("mongoose");
if (process.env.TRACK_ROLLING_PROOF_FIXTURE !== "isolated" || !/^mongodb:\/\/127\.0\.0\.1:\d+\/rolling-proof\?replicaSet=proof$/.test(process.env.MONGODB_URI ?? "")) {
  throw new Error("The rolling scheduler fixture requires its isolated loopback database");
}
registerRecurringJob("rolling-proof-ownership", 1000, async ({ signal }) => {
  signal.throwIfAborted();
  const records = mongoose.connection.db.collection("rollingproofjobs");
  const started = await records.findOneAndUpdate({ _id: "singleton" }, {
    $inc: { active: 1, started: 1 }, $addToSet: { processes: process.pid },
  }, { upsert: true, returnDocument: "after" });
  await records.updateOne({ _id: "singleton" }, { $max: { maximumActive: started.active } });
  try {
    // Spans the next process's 10-second poll and twelve original lease periods.
    // Accepted work deliberately finishes during drain while its lease renews.
    await sleep(12_000);
  } finally {
    await records.updateOne({ _id: "singleton" }, { $inc: { active: -1, completed: 1 } });
  }
}, { leaseMs: 1000 });
