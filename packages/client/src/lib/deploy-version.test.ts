import { describe, expect, it, vi } from "vitest";

import {
  createDeployWatcher,
  DEPLOY_CHECK_INTERVAL_MS,
  readDeployedCommit,
  reloadWhenIdle,
  shouldWatchForDeploys,
} from "./deploy-version";

const web = { bakedCommit: "aaa", isProductionBuild: true, isAppShell: false };

describe("shouldWatchForDeploys", () => {
  it("watches a stamped production web build", () => {
    expect(shouldWatchForDeploys(web)).toBe(true);
  });

  it("skips a build without a commit", () => {
    expect(shouldWatchForDeploys({ ...web, bakedCommit: "" })).toBe(false);
    expect(shouldWatchForDeploys({ ...web, bakedCommit: "  " })).toBe(false);
  });

  it("skips the native and desktop shells, even with a commit baked in", () => {
    expect(shouldWatchForDeploys({ ...web, isAppShell: true })).toBe(false);
  });

  it("skips dev", () => {
    expect(shouldWatchForDeploys({ ...web, isProductionBuild: false })).toBe(false);
  });
});

describe("readDeployedCommit", () => {
  it("reads the commit", () => {
    expect(readDeployedCommit({ commit: "bbb", version: "0.1.0", apiUrl: "" })).toBe("bbb");
  });

  it("treats an unstamped or malformed answer as no answer", () => {
    expect(readDeployedCommit({ commit: "" })).toBeNull();
    expect(readDeployedCommit({ commit: 3 })).toBeNull();
    expect(readDeployedCommit(null)).toBeNull();
    expect(readDeployedCommit("<html>")).toBeNull();
  });
});

const setup = (fetchCommit: () => Promise<string | null>) => {
  let clock = 1_000_000;
  const onNewVersion = vi.fn();
  const fetchSpy = vi.fn(fetchCommit);
  const watcher = createDeployWatcher({
    bakedCommit: "aaa",
    fetchCommit: fetchSpy,
    onNewVersion,
    now: () => clock,
  });
  return {
    watcher,
    onNewVersion,
    fetchSpy,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("createDeployWatcher", () => {
  it("does not ask within the interval after load", async () => {
    const { watcher, fetchSpy, advance } = setup(async () => "bbb");
    await watcher.check();
    advance(DEPLOY_CHECK_INTERVAL_MS - 1);
    await watcher.check();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks at most once per interval however often focus fires", async () => {
    const { watcher, fetchSpy, advance } = setup(async () => "aaa");
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    await watcher.check();
    advance(60_000);
    await watcher.check();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not start a second request while one is in flight", async () => {
    let resolve: (value: string) => void = () => undefined;
    const { watcher, fetchSpy, advance } = setup(
      () => new Promise<string>((r) => (resolve = r)),
    );
    advance(DEPLOY_CHECK_INTERVAL_MS);
    const first = watcher.check();
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    resolve("aaa");
    await first;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the live commit matches the bundle", async () => {
    const { watcher, onNewVersion, advance } = setup(async () => "aaa");
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    expect(onNewVersion).not.toHaveBeenCalled();
  });

  it("announces a different commit once, and a later one again", async () => {
    let live = "bbb";
    const { watcher, onNewVersion, advance } = setup(async () => live);
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    expect(onNewVersion).toHaveBeenCalledTimes(1);
    expect(onNewVersion).toHaveBeenCalledWith("bbb");
    live = "ccc";
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    expect(onNewVersion).toHaveBeenCalledTimes(2);
    expect(onNewVersion).toHaveBeenLastCalledWith("ccc");
  });

  it("ignores failures and unstamped answers", async () => {
    let fail = true;
    const { watcher, onNewVersion, advance } = setup(async () => {
      if (fail) throw new Error("offline");
      return null;
    });
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    fail = false;
    advance(DEPLOY_CHECK_INTERVAL_MS);
    await watcher.check();
    expect(onNewVersion).not.toHaveBeenCalled();
  });
});

describe("reloadWhenIdle", () => {
  const activity = (count: { value: number }) => {
    const listeners = new Set<() => void>();
    return {
      api: {
        isMutating: () => count.value,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      emit: () => listeners.forEach((l) => l()),
      listeners,
    };
  };

  it("reloads straight away with nothing in flight", () => {
    const reload = vi.fn();
    reloadWhenIdle(activity({ value: 0 }).api, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("waits for writes in flight to settle", () => {
    const count = { value: 1 };
    const a = activity(count);
    const reload = vi.fn();
    reloadWhenIdle(a.api, reload);
    a.emit();
    expect(reload).not.toHaveBeenCalled();
    count.value = 0;
    a.emit();
    a.emit();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(a.listeners.size).toBe(0);
  });

  it("reloads after the timeout when a write never settles", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      reloadWhenIdle(activity({ value: 1 }).api, reload, 5_000);
      vi.advanceTimersByTime(4_999);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be cancelled", () => {
    vi.useFakeTimers();
    try {
      const count = { value: 1 };
      const a = activity(count);
      const reload = vi.fn();
      const cancel = reloadWhenIdle(a.api, reload, 5_000);
      cancel();
      count.value = 0;
      a.emit();
      vi.advanceTimersByTime(10_000);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
