/**
 * A write and a workspace switch that land at the same time.
 *
 * The worker handles popup messages concurrently, so a switch can arrive while
 * an earlier start's request is still hanging on a bad network. The attempt
 * and the queued row must agree on the workspace: the request names the
 * workspace active when the write began, and a transport failure stamps the
 * row with that same one — never with the workspace switched to meanwhile,
 * which would replay the work into a workspace it was not made in.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceSummary, WorkspacePermissions } from "@starter/core";
import { saveSession } from "../lib/session";
import { createEntry, removeEntry } from "./entries";
import {
  getActiveWorkspaceId,
  getOfflineQueue,
  reload,
  resolveWorkspaces,
  switchWorkspace,
} from "./runtime";
import { startTimer, stopTimer } from "./timer";

const A = "ws-a";
const B = "ws-b";

const permissions: WorkspacePermissions = {
  inviteMembers: false,
  inviteAdmins: false,
  changeRoles: false,
  editTimeVisibility: false,
  editMoneyVisibility: false,
  removeMembers: false,
  transferOwnership: false,
  invoices: false,
  viewOthersTime: false,
  viewOthersMoney: false,
};
const workspace = (id: string, isDefault: boolean): WorkspaceSummary => ({
  id,
  name: id,
  role: "member",
  memberCount: 2,
  isDefault,
  permissions,
});

type Call = { path: string; input: Record<string, unknown> | undefined };
const calls: Call[] = [];
/** Resolved by the test to let a hanging write fail as a dead network would. */
let failHanging: (() => void) | null = null;

const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/api\/trpc\//, "");
  const raw = init?.method === "POST" ? String(init.body) : parsed.searchParams.get("input");
  const input = raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  calls.push({ path, input });
  if (path === "workspaces.list") {
    return new Response(
      JSON.stringify({ result: { data: [workspace(A, true), workspace(B, false)] } }),
    );
  }
  if (path.startsWith("entries.") && init?.method === "POST") {
    await new Promise<void>((resolve) => {
      failHanging = resolve;
    });
    throw new TypeError("fetch failed");
  }
  return new Response(JSON.stringify({ result: { data: null } }));
};

beforeEach(async () => {
  calls.length = 0;
  failHanging = null;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  await saveSession({ token: "token-1", userId: "user-me", email: "me@example.com" });
  await reload();
  await getOfflineQueue().clear();
  await resolveWorkspaces();
  expect(getActiveWorkspaceId()).toBe(A);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const switchWhileHanging = async (write: Promise<unknown>): Promise<void> => {
  await vi.waitFor(() => expect(failHanging).not.toBeNull());
  expect(await switchWorkspace(B)).toBe(true);
  failHanging?.();
  await write;
};

test.each([
  ["entries.start", () => startTimer("hung", null)],
  ["entries.stop", () => stopTimer()],
  [
    "entries.create",
    () =>
      createEntry({
        description: "hung",
        projectId: null,
        taskId: null,
        billable: false,
        start: "2026-09-14T09:00:00.000Z",
        end: "2026-09-14T10:00:00.000Z",
      } as never),
  ],
  ["entries.remove", () => removeEntry("e-server-1")],
])("%s: the attempt and the queued row name the workspace the write began in", async (op, write) => {
  await switchWhileHanging(write());

  const attempt = calls.find((call) => call.path === op);
  expect(attempt?.input?.workspaceId).toBe(A);
  const rows = await getOfflineQueue().list();
  expect(rows.map((row) => [row.op, row.workspaceId])).toEqual([[op, A]]);
  expect(getActiveWorkspaceId()).toBe(B);
});
