import { describe, expect, it } from "vitest";
import { memoryStorage, type KeyValueStorage } from "@starter/core";
import { createSavedReportStore, relativeReportRange, reportStorageKey, resolveSavedReportQuery, savedReportQuery } from "./saved-report-views";

const identity = { userId: "user-a", server: "https://time.example", workspaceId: "workspace-a" };
const range = { from: "2026-10-01", to: "2026-10-07" };

describe("saved report dates", () => {
  it("re-resolves a saved week on the current day in the requested timezone", () => {
    const query = savedReportQuery("preset=thisWeek&from=2026-09-28&to=2026-10-04&tags=tag&view=entries&group=task&sort=duration&dir=asc&q=review", range);
    const view = { id: "v", name: "Review", query };
    const instant = new Date("2026-10-04T15:00:00Z");
    const sydney = new URLSearchParams(resolveSavedReportQuery(view, 1, instant, "Australia/Sydney"));
    const berlin = new URLSearchParams(resolveSavedReportQuery(view, 1, instant, "Europe/Berlin"));
    expect(sydney.get("from")).toBe("2026-10-05"); expect(sydney.get("to")).toBe("2026-10-11");
    expect(berlin.get("from")).toBe("2026-09-28"); expect(berlin.get("to")).toBe("2026-10-04");
    expect(sydney.get("tags")).toBe("tag"); expect(sydney.get("view")).toBe("entries"); expect(sydney.get("dir")).toBe("asc");
  });
  it("keeps custom dates fixed even if they happen to equal this week", () => {
    const query = savedReportQuery("from=2026-10-01&to=2026-10-07&projects=p", range);
    expect(resolveSavedReportQuery({ id: "v", name: "Fixed", query }, 1, new Date("2030-01-01"), "UTC")).toBe(query);
    expect(new URLSearchParams(query).has("preset")).toBe(false);
  });
  it("keeps the implicit default week relative and drops unrelated URL keys", () => {
    const params = new URLSearchParams(savedReportQuery("tasks=t&unrelated=private", range));
    expect(params.get("preset")).toBe("thisWeek"); expect(params.get("tasks")).toBe("t"); expect(params.has("unrelated")).toBe(false);
  });
  it("resolves last month at year rollover, leap years and Sunday-start weeks", () => {
    expect(relativeReportRange("lastMonth", 1, new Date("2027-01-01T12:00:00Z"), "UTC")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(relativeReportRange("thisMonth", 1, new Date("2028-02-15T12:00:00Z"), "UTC")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(relativeReportRange("thisWeek", 0, new Date("2026-10-04T12:00:00Z"), "UTC")).toEqual({ from: "2026-10-04", to: "2026-10-10" });
  });
});

describe("saved report storage", () => {
  it("isolates each user, server and workspace while normalizing server origins", async () => {
    const storage = memoryStorage();
    const original = createSavedReportStore(identity, storage);
    const views = [{ id: "v", name: "Mine", query: "preset=today" }];
    await original.write(views);
    expect(await original.load()).toEqual(views);
    for (const other of [{ ...identity, userId: "user-b" }, { ...identity, workspaceId: "workspace-b" }, { ...identity, server: "https://other.example" }]) {
      expect(await createSavedReportStore(other, storage).load()).toEqual([]);
      expect(reportStorageKey(other)).not.toBe(reportStorageKey(identity));
    }
    expect(reportStorageKey({ ...identity, server: "https://time.example/" })).toBe(reportStorageKey(identity));
  });
  it("fails closed if an envelope is moved into another account's key", async () => {
    const storage = memoryStorage();
    await createSavedReportStore(identity, storage).write([{ id: "v", name: "Secret", query: "q=private" }]);
    const other = { ...identity, userId: "other" };
    await storage.setItem(reportStorageKey(other), (await storage.getItem(reportStorageKey(identity)))!);
    await expect(createSavedReportStore(other, storage).load()).rejects.toThrow("identity mismatch");
  });
  it("surfaces read and write failures without claiming an empty list or a saved result", async () => {
    const storage: KeyValueStorage = { getItem: async () => { throw Error("read failed"); }, setItem: async () => { throw Error("disk full"); }, removeItem: async () => {} };
    const store = createSavedReportStore(identity, storage);
    await expect(store.load()).rejects.toThrow("read failed");
    await expect(store.write([])).rejects.toThrow("disk full");
  });
  it("refuses corrupt records without removing or overwriting them", async () => {
    const storage = memoryStorage();
    const key = reportStorageKey(identity);
    await storage.setItem(key, "bad JSON");
    await expect(createSavedReportStore(identity, storage).load()).rejects.toThrow();
    expect(await storage.getItem(key)).toBe("bad JSON");
  });
});

describe("saved views use strict native Preferences", () => {
  it("never claims success or falls back to evictable web storage when the bridge fails", async () => {
    const { preferencesStorage } = await import("@/mobile/preferences-storage");
    const plugin = { get: async () => ({ value: null }), set: async () => { throw Error("native disk full"); }, remove: async () => {} };
    const store = createSavedReportStore(identity, preferencesStorage({ strict: true, loadPlugin: async () => plugin }));
    await expect(store.write([{ id: "v", name: "Daily", query: "preset=today" }])).rejects.toThrow("native disk full");
    const unavailable = createSavedReportStore(identity, preferencesStorage({ strict: true, loadPlugin: async () => null }));
    await expect(unavailable.load()).rejects.toThrow("Persistent native storage is unavailable");
  });
});

describe("saved all-time views", () => {
  it("uses the current tracked span rather than freezing the date range at save time", () => {
    const query = savedReportQuery("preset=allTime&from=2020-01-01&to=2026-01-01&tasks=t", range);
    const view = { id: "v", name: "Everything", query };
    expect(new URLSearchParams(query).has("from")).toBe(false);
    const resolved = new URLSearchParams(resolveSavedReportQuery(view, 1, new Date("2026-10-03"), "UTC", { from: "2019-05-01", to: "2026-10-03" }));
    expect(resolved.get("from")).toBe("2019-05-01"); expect(resolved.get("to")).toBe("2026-10-03"); expect(resolved.get("tasks")).toBe("t");
    expect(() => resolveSavedReportQuery(view, 1)).toThrow("Tracked range unavailable");
  });
});
