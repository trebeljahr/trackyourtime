import * as workerThreads from "node:worker_threads";
// jsdom has no Web Locks; Node's worker_threads has them. Read the export
// without a named import: @types/node 22.20 stopped declaring it, while the
// runtime still provides it.
const nodeLocks = (workerThreads as { locks?: LockManager }).locks;
if (typeof navigator !== "undefined" && !navigator.locks && nodeLocks)
  Object.defineProperty(navigator, "locks", { configurable: true, value: nodeLocks });

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach } from "vitest";
import { closeActivityDatabase } from "../background/activity/store";
import { createFakeChrome, type FakeChrome } from "./fake-chrome";

declare global {
  // Tests reach the driver through this; the modules under test see `chrome`.
  var fakeChrome: FakeChrome["control"];
}

beforeEach(() => {
  const fake = createFakeChrome();
  (globalThis as unknown as { chrome: unknown }).chrome = fake.api;
  globalThis.fakeChrome = fake.control;
  // A fresh database per test, so no test sees another's rows.
  globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
  await closeActivityDatabase();
});
