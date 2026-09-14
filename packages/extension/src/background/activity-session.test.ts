/**
 * The two places activity capture meets the session: an accepted suggestion
 * leaving through the ordinary create path (offline queue included), and
 * sign-out taking every stored row with it.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  applyActivitySettings,
  browserBlurred,
  heartbeat,
  observeActiveTab,
  setActivityScope,
} from "./activity/capture";
import { CAPTURE_PERMISSIONS, ACTIVITY_SCOPE_KEY } from "./activity/settings";
import {
  addDismissal,
  listDismissals,
  listRules,
  loadOpenSegment,
  putRule,
  readAllSegments,
} from "./activity/store";
import { acceptSuggestion, resolveActivitySnapshot, setActivityDay } from "./entries";
import { forgetSession, getOfflineQueue, reload } from "./runtime";
import { saveSession } from "../lib/session";

const MIN = 60_000;
const T0 = Date.parse("2026-09-14T09:00:00.000Z");
const SCOPE = "user-1:ws-1";

let minutes = 0;
const advanceTo = async (to: number): Promise<void> => {
  while (minutes < to) {
    minutes += 1;
    vi.setSystemTime(T0 + minutes * MIN);
    await heartbeat();
  }
};

const browse = async (): Promise<void> => {
  await chrome.permissions.request(CAPTURE_PERMISSIONS);
  await setActivityScope("user-1", "ws-1");
  await applyActivitySettings({ enabled: true });
  const hosts = ["docs.example.com", "code.example.com"];
  for (let minute = 0; minute < 30; minute += 3) {
    await advanceTo(minute);
    fakeChrome.showTab({ url: `https://${hosts[minute % 2]}/` });
    await observeActiveTab();
  }
  await advanceTo(30);
  await browserBlurred();
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  minutes = 0;
  vi.setSystemTime(T0);
  // No server is reachable: every request fails in transport, which is what
  // a real `fetch` does with the network gone.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("fetch failed");
  }));
  await saveSession({ token: "token-1", userId: "user-1", email: "a@example.com" });
  await reload();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("accepting a suggestion offline queues an ordinary create with source extension", async () => {
  await browse();
  setActivityDay("2026-09-14");

  const snapshot = await resolveActivitySnapshot("suggestions");
  const [suggestion] = snapshot.suggestions ?? [];
  expect(suggestion).toBeDefined();
  if (suggestion === undefined) return;

  await acceptSuggestion({
    start: suggestion.start,
    end: suggestion.end,
    edited: false,
    description: "Review",
    projectId: null,
    taskId: null,
  });

  const queued = await getOfflineQueue().list();
  expect(queued).toHaveLength(1);
  expect(queued[0]?.op).toBe("entries.create");
  expect((queued[0]?.payload as { input?: unknown } | undefined)?.input).toMatchObject({
    description: "Review",
    source: "extension",
    start: new Date(T0).toISOString(),
    end: new Date(T0 + 30 * MIN).toISOString(),
  });

  // The queued create is tracked time now: the same span is not offered again.
  const after = await resolveActivitySnapshot("suggestions");
  expect(after.suggestions).toEqual([]);

  // And a second accept of the stale suggestion is refused rather than duplicated.
  await expect(
    acceptSuggestion({
      start: suggestion.start,
      end: suggestion.end,
      edited: false,
      description: "Review",
      projectId: null,
      taskId: null,
    }),
  ).rejects.toMatchObject({ code: "SUGGESTION_ALREADY_TRACKED" });
  expect(await getOfflineQueue().size()).toBe(1);
});

test("signing out removes all stored activity, rules and dismissals", async () => {
  await browse();
  fakeChrome.showTab({ url: "https://docs.example.com/" });
  await observeActiveTab();
  await putRule(SCOPE, { id: "r1", pattern: "docs.example.com", projectId: "p1" }, T0);
  await addDismissal({ scope: SCOPE, start: T0, end: T0 + MIN });
  expect((await readAllSegments()).length).toBeGreaterThan(0);

  await forgetSession();

  expect(await readAllSegments()).toEqual([]);
  expect(await loadOpenSegment()).toBeNull();
  expect(await listRules(SCOPE)).toEqual([]);
  expect(await listDismissals(SCOPE)).toEqual([]);
  expect(await chrome.storage.local.get(ACTIVITY_SCOPE_KEY)).toEqual({});
});
