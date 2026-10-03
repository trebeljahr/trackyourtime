import assert from "node:assert/strict";
import test from "node:test";
import { startWebhookSweeper, stopWebhookSweeper, WEBHOOK_SWEEP_INTERVAL_MS } from "../services/webhooks/sweeper.js";

test("stopping the webhook sweeper waits for accepted delivery work and prevents new claims", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish!: () => void;
  let passes = 0;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  t.after(async () => { finish(); await stopWebhookSweeper(); });
  startWebhookSweeper({ isTest: false, runSweep: async () => { passes += 1; await pending; } });
  t.mock.timers.tick(WEBHOOK_SWEEP_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(passes, 1);
  let stopped = false;
  const stop = stopWebhookSweeper().then(() => { stopped = true; });
  t.mock.timers.tick(WEBHOOK_SWEEP_INTERVAL_MS * 2);
  await Promise.resolve();
  assert.equal(passes, 1);
  assert.equal(stopped, false);
  finish();
  await stop;
  assert.equal(stopped, true);
});
