/**
 * An older build opening an activity database a newer build upgraded.
 *
 * IndexedDB refuses a lower version outright. What must follow is a stopped
 * capture and a visible reason — never a crash loop, and never a deleted
 * database, which holds data the newer build still reads.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyActivitySettings, observeActiveTab, setActivityScope } from "./capture";
import { CAPTURE_PERMISSIONS } from "./settings";
import {
  ACTIVITY_DB_NAME,
  ActivityStorageUnavailableError,
  activityStorageProblem,
  probeActivityStorage,
  readAllSegments,
} from "./store";
import { resolveActivitySnapshot } from "../entries";

/** What a future build leaves behind: the same database at a higher version. */
const openAsNewerBuild = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(ACTIVITY_DB_NAME, 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("from-the-future");
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await openAsNewerBuild();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("reports the newer version instead of throwing an unexplained error", async () => {
  expect(await probeActivityStorage()).toBe("newer-version");
  expect(activityStorageProblem()).toBe("newer-version");
  await expect(readAllSegments()).rejects.toBeInstanceOf(ActivityStorageUnavailableError);
  // Logged once, not on every attempt.
  expect(console.warn).toHaveBeenCalledTimes(1);
});

test("capture records nothing and does not throw", async () => {
  await chrome.permissions.request(CAPTURE_PERMISSIONS);
  await setActivityScope("user-1", "ws-1");
  await applyActivitySettings({ enabled: true }).catch(() => undefined);
  fakeChrome.showTab({ url: "https://docs.example.com/" });
  await expect(observeActiveTab()).resolves.toBeUndefined();
});

test("Settings → Activity says why, with capture shown off", async () => {
  const snapshot = await resolveActivitySnapshot("settings");
  expect(snapshot.storageProblem).toBe("newer-version");
  expect(snapshot.rules).toEqual([]);
  expect(snapshot.storedSegments).toBeNull();

  const suggestions = await resolveActivitySnapshot("suggestions");
  expect(suggestions.suggestions).toEqual([]);
});

test("the database is left in place for the newer build", async () => {
  await probeActivityStorage();
  const databases = await indexedDB.databases();
  expect(databases).toContainEqual({ name: ACTIVITY_DB_NAME, version: 2 });
});
