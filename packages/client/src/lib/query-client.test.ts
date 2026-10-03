/**
 * Where `networkMode: "always"` may and may not appear.
 *
 * It was originally set as a global `defaultOptions.mutations`, justified
 * entirely by the two mutation families that queue offline work. That
 * justification does not reach the other forty-odd mutations in the app —
 * profile edits, catalog renames, invoice writes, the calendar's drag-to-move,
 * every one of them on the web as well as on the phone. React Query's default
 * *pauses* those while offline and replays them on reconnect with their
 * optimistic state intact; "always" replaced that with an immediate rejection,
 * a rollback and an error toast on any blip.
 *
 * So the option is now opt-in per mutation, and these specs pin both halves:
 * the client's own defaults leave mutations alone, and the option still does
 * the thing the queue depends on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  focusManager,
  MutationObserver,
  onlineManager,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import {
  OFFLINE_QUEUED_MUTATION,
  createAppQueryClient,
} from "@/lib/query-client";

afterEach(() => {
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

/** Fire a mutation and report whether its `mutationFn` ever ran. */
const runMutation = async (
  extra: Record<string, unknown>,
): Promise<{ ran: boolean; settled: boolean }> => {
  const client = createAppQueryClient();
  let ran = false;
  const observer = new MutationObserver(client, {
    ...extra,
    mutationFn: async () => {
      ran = true;
      throw new TypeError("Load failed");
    },
    retry: false,
  });

  let settled = false;
  void observer.mutate(undefined).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // A rejection settles on a microtask; a paused mutation never settles at all.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ran, settled };
};

describe("createAppQueryClient", () => {
  it.each(["projects", "clients", "tasks", "tags"] as const)(
    "%s lists stay fresh across remount and focus, then refetch on invalidation",
    async (router) => {
      const client = createAppQueryClient();
      const queryKey = [[router, "list"], { input: {}, type: "query" }] as const;
      let requests = 0;
      const options = client.defaultQueryOptions({
        queryKey,
        queryFn: async () => ++requests,
      });
      const first = new QueryObserver(client, options);
      const unsubscribeFirst = first.subscribe(() => {});

      await first.refetch();
      unsubscribeFirst();

      const remounted = new QueryObserver(client, options);
      const unsubscribeRemounted = remounted.subscribe(() => {});
      expect(requests).toBe(1);

      client.mount();
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toBe(1);

      await client.invalidateQueries({ queryKey: [[router, "list"]] });
      expect(requests).toBe(2);

      unsubscribeRemounted();
      client.unmount();
    },
  );

  it("does not set networkMode on mutations globally", () => {
    const defaults = createAppQueryClient().getDefaultOptions();
    expect(defaults.mutations?.networkMode).toBeUndefined();
  });

  it("lets an ordinary mutation pause while offline", async () => {
    onlineManager.setOnline(false);

    const { ran, settled } = await runMutation({});

    // Paused: the fn never runs, so nothing rolls back and nothing toasts.
    expect(ran).toBe(false);
    expect(settled).toBe(false);
  });

  it("runs an OFFLINE_QUEUED_MUTATION offline so onError can queue it", async () => {
    onlineManager.setOnline(false);

    const { ran, settled } = await runMutation({ ...OFFLINE_QUEUED_MUTATION });

    expect(ran).toBe(true);
    expect(settled).toBe(true);
  });
});

// ── the option stays where it was argued for ─────────────────────────

const srcDir = fileURLToPath(new URL("..", import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(item.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(item.name)) return [];
    return [path];
  });

/**
 * Comments out, so the several places that *explain* the option are not
 * mistaken for places that set it. Crude on purpose — over-stripping can only
 * hide text, and the only text this looks for is a property assignment.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("networkMode across the client", () => {
  it("is written down in exactly one place", () => {
    const offenders = sourceFiles(srcDir).filter(
      (path) =>
        !path.endsWith(join("lib", "query-client.ts")) &&
        /networkMode\s*:/.test(withoutComments(readFileSync(path, "utf8"))),
    );

    // Anything else spells it out ad hoc, which is how it went global the
    // first time. Spread `OFFLINE_QUEUED_MUTATION` instead — and only into a
    // mutation whose failure something actually catches.
    expect(offenders).toEqual([]);
  });

  it("is opted into by the three families that queue", () => {
    const users = [
      join("components", "tracker", "use-entry-mutations.ts"),
      join("components", "timesheet", "use-timesheet-mutations.ts"),
      join("hooks", "use-offline-queue.ts"),
    ];

    for (const relative of users) {
      const source = readFileSync(join(srcDir, relative), "utf8");
      expect(source).toContain("OFFLINE_QUEUED_MUTATION");
    }
  });
});
