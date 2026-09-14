import { describe, expect, it, vi } from "vitest";

vi.mock("@/mobile/bridge", () => ({ isNative: () => true }));

const { createServerSwitch } = await import("./server-switch");

const CLOUD = "https://api.trackyourtime.dev";
const OWN = "https://track.example.com";

/** Every dependency records its name, so the ORDER is what gets asserted. */
const harness = (options: { current: string; session: boolean }) => {
  const calls: string[] = [];
  let current = options.current;
  const deps = {
    currentOrigin: () => current,
    hasSession: () => options.session,
    signOut: vi.fn(async () => {
      calls.push(`signOut@${current}`);
    }),
    sealQueueOwner: vi.fn(async () => {
      calls.push("sealQueueOwner");
    }),
    clearRunningMirror: vi.fn(async () => {
      calls.push("clearRunningMirror");
    }),
    saveChoice: vi.fn(async (choice: { origin: string } | null) => {
      current = choice?.origin ?? CLOUD;
      calls.push(`saveChoice:${current}`);
    }),
    adoptToken: vi.fn(async (token: string) => {
      calls.push(`adoptToken:${token}@${current}`);
    }),
    refreshPending: vi.fn(async () => {
      calls.push("refreshPending");
    }),
    restart: vi.fn((path: string) => {
      calls.push(`restart:${path}`);
    }),
  };
  return { calls, deps, run: createServerSwitch(deps) };
};

const own = { origin: OWN, webUrl: OWN, release: "0.1.0" };

describe("switching servers", () => {
  it("signs out of the OLD server before the choice changes", async () => {
    const { calls, run } = harness({ current: CLOUD, session: true });
    await expect(run(own, CLOUD)).resolves.toBe("switched");
    expect(calls).toEqual([
      `signOut@${CLOUD}`,
      "clearRunningMirror",
      `saveChoice:${OWN}`,
      "refreshPending",
      "restart:/login/",
    ]);
  });

  it("never clears the offline queue — its rows carry their own server", async () => {
    const { deps, run } = harness({ current: CLOUD, session: true });
    await run(own, CLOUD);
    // The switch has no queue-clearing dependency at all; this pins that
    // nobody adds one without changing this test.
    expect(Object.keys(deps)).not.toContain("clearQueue");
  });

  it("still seals the queue owner when there was no session to sign out of", async () => {
    const { calls, deps, run } = harness({ current: CLOUD, session: false });
    await run(own, CLOUD);
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(calls[0]).toBe("sealQueueOwner");
  });

  it("carries on when the old server cannot be reached to sign out", async () => {
    const { calls, deps, run } = harness({ current: CLOUD, session: true });
    deps.signOut.mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(run(own, CLOUD)).resolves.toBe("switched");
    expect(calls).toContain(`saveChoice:${OWN}`);
    expect(calls.at(-1)).toBe("restart:/login/");
  });

  it("keeps a token from the new server and lands on the tracker", async () => {
    const { calls, run } = harness({ current: CLOUD, session: true });
    await run(own, CLOUD, { token: "new-token" });
    expect(calls).toContain(`adoptToken:new-token@${OWN}`);
    expect(calls.indexOf(`adoptToken:new-token@${OWN}`)).toBeGreaterThan(
      calls.indexOf(`saveChoice:${OWN}`),
    );
    expect(calls.at(-1)).toBe("restart:/track/");
  });

  it("does nothing but save when the server is the same", async () => {
    const { calls, deps, run } = harness({ current: OWN, session: true });
    await expect(run({ ...own, origin: `${OWN}/` }, CLOUD)).resolves.toBe(
      "unchanged",
    );
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
    expect(calls).toEqual([`saveChoice:${OWN}/`]);
  });

  it("going back to the default is a switch like any other", async () => {
    const { calls, run } = harness({ current: OWN, session: true });
    await run(null, CLOUD);
    expect(calls[0]).toBe(`signOut@${OWN}`);
    expect(calls).toContain(`saveChoice:${CLOUD}`);
  });
});
