import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SYNC_EVENT_KINDS,
  isKnownCatalogScope,
  isKnownIntegrationScope,
  isKnownSyncEventKind,
  type SyncEvent,
  type TimeEntry,
  type WorkspaceSummary,
} from "@starter/shared";
import {
  emptyWorkspaceChoice,
  isHeldByWorkspace,
  isOwnActivity,
  isOwnEntry,
  ownEntries,
  parseWorkspaceChoice,
  rememberWorkspaceNames,
  resolveActiveWorkspaceId,
  syncEventReach,
  withWorkspaceList,
  workspaceChoiceFor,
  workspaceNameIn,
  workspaceScopedKey,
} from "../workspace-context.js";

const summary = (id: string, name: string, isDefault = false): WorkspaceSummary =>
  ({ id, name, isDefault, role: "member", memberCount: 2 }) as WorkspaceSummary;

const A = summary("ws-a", "Acme", true);
const B = summary("ws-b", "Beta");

const entry = (authorId: string): TimeEntry => ({ id: "e", authorId }) as TimeEntry;

test("a stored id resolves only while it is a membership", () => {
  assert.equal(resolveActiveWorkspaceId("ws-b", [A, B]), "ws-b");
  assert.equal(resolveActiveWorkspaceId("ws-gone", [B, A]), "ws-a");
  assert.equal(resolveActiveWorkspaceId("ws-b", null), "ws-b");
  assert.equal(resolveActiveWorkspaceId(null, []), null);
});

test("another workspace's events reach only the timer and the membership list", () => {
  const upserted: SyncEvent = { kind: "entry.upserted", entry: entry("me") };
  assert.equal(syncEventReach(upserted, "ws-a", "ws-a"), "all");
  assert.equal(syncEventReach(upserted, "ws-b", "ws-a"), "timer");
  assert.equal(syncEventReach({ kind: "catalog.changed", scope: "project" }, "ws-b", "ws-a"), "ignore");
  assert.equal(
    syncEventReach({ kind: "membership.changed", workspaceId: "ws-b", reason: "removed" }, "ws-b", "ws-a"),
    "membership",
  );
  assert.equal(syncEventReach({ kind: "settings.changed" }, undefined, "ws-a"), "all");
});

test("own entries are the signed-in person's, and an unknown person owns nothing", () => {
  const rows = [entry("me"), entry("colleague")];
  assert.deepEqual(ownEntries(rows, "me").map((row) => row.authorId), ["me"]);
  assert.deepEqual(ownEntries(rows, null), []);
  assert.equal(isOwnEntry(entry(""), ""), false);
  assert.equal(isOwnActivity({ kind: "timer.started", entry: entry("colleague") }, "ws-a", "me"), false);
  assert.equal(isOwnActivity({ kind: "settings.changed" }, undefined, "me"), true);
});

test("a stored choice round-trips, and garbage reads as never chosen", () => {
  const installed = withWorkspaceList(emptyWorkspaceChoice(), [A, B], {
    server: "https://api.example",
    userId: "me",
  });
  assert.equal(installed.activeId, "ws-a");
  assert.equal(installed.moved, true);
  const back = parseWorkspaceChoice(JSON.stringify(installed.choice));
  assert.deepEqual(back, installed.choice);
  assert.deepEqual(parseWorkspaceChoice("{not json"), emptyWorkspaceChoice());
  assert.deepEqual(parseWorkspaceChoice(JSON.stringify({ workspaces: [{ id: 7 }] })).workspaces, []);
});

test("a list that drops the chosen workspace moves the choice and keeps its name", () => {
  const chosen = { ...withWorkspaceList(emptyWorkspaceChoice(), [A, B]).choice, workspaceId: "ws-b" };
  const after = withWorkspaceList(chosen, [A]);
  assert.equal(after.activeId, "ws-a");
  assert.equal(after.moved, true);
  assert.equal(workspaceNameIn(after.choice, "ws-b"), "Beta");
  assert.equal(withWorkspaceList(after.choice, [A]).moved, false);
});

test("another account's or another server's choice does not apply", () => {
  const choice = { ...emptyWorkspaceChoice(), server: "https://a", userId: "me", workspaceId: "ws-a" };
  assert.equal(workspaceChoiceFor(choice, { server: "https://a", userId: "me" }).workspaceId, "ws-a");
  assert.equal(workspaceChoiceFor(choice, { server: "https://a", userId: "other" }).workspaceId, null);
  assert.equal(workspaceChoiceFor(choice, { server: "https://b", userId: "me" }).workspaceId, null);
  assert.equal(workspaceChoiceFor(choice, { server: "https://a", userId: null }).workspaceId, "ws-a");
});

test("remembered names are capped, oldest first, and never dropped by a shorter list", () => {
  let names: Record<string, string> = {};
  for (let i = 0; i < 60; i += 1) names = rememberWorkspaceNames(names, [summary(`ws-${i}`, `W${i}`)]);
  assert.equal(Object.keys(names).length, 50);
  assert.equal(names["ws-0"], undefined);
  assert.equal(names["ws-59"], "W59");
});

test("a row is held only against a known list that lacks its workspace", () => {
  assert.equal(isHeldByWorkspace({ workspaceId: "ws-b" }, [A]), true);
  assert.equal(isHeldByWorkspace({ workspaceId: "ws-a" }, [A]), false);
  assert.equal(isHeldByWorkspace({}, [A]), false);
  assert.equal(isHeldByWorkspace({ workspaceId: "ws-b" }, null), false);
});

test("workspace-scoped keys fall back to the bare key while nothing is resolved", () => {
  assert.equal(workspaceScopedKey("cache", "ws-a"), "cache:ws-a");
  assert.notEqual(workspaceScopedKey("cache", "ws-a"), workspaceScopedKey("cache", "ws-b"));
  assert.equal(workspaceScopedKey("cache", null), "cache");
});

test("an event kind this build does not know reaches the timer from another workspace", () => {
  const unknown = { kind: "timer.paused" } as unknown as SyncEvent;
  assert.equal(syncEventReach(unknown, "ws-b", "ws-a"), "timer");
  assert.equal(syncEventReach(unknown, "ws-a", "ws-a"), "all");
  // A known non-timer kind from another workspace is still ignored.
  assert.equal(syncEventReach({ kind: "favorites.changed" }, "ws-b", "ws-a"), "ignore");
});

test("known sync kinds and scopes are exactly the union's", () => {
  assert.equal(isKnownSyncEventKind("timer.started"), true);
  assert.equal(isKnownSyncEventKind("timer.paused"), false);
  assert.equal(isKnownSyncEventKind("toString"), false);
  assert.equal(SYNC_EVENT_KINDS.length, 11);
  assert.equal(isKnownCatalogScope("tag"), true);
  assert.equal(isKnownCatalogScope("rate"), false);
  assert.equal(isKnownIntegrationScope("webhook"), true);
  assert.equal(isKnownIntegrationScope("oauth-app"), false);
});
