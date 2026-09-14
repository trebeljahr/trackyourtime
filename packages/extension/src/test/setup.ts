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
