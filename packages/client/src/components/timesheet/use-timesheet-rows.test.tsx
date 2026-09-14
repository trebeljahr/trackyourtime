// @vitest-environment jsdom
/**
 * Pinned timesheet rows name projects by id, and project ids belong to one
 * workspace. One list per device showed workspace A's rows in B as rows for
 * projects B does not have; the list is now per workspace and follows a switch.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "@starter/core";

import * as activeWorkspace from "@/lib/active-workspace";
import { __resetTimesheetRowsForTests, useTimesheetRows } from "./use-timesheet-rows";

const workspace = (id: string, isDefault: boolean): WorkspaceSummary => ({
  id,
  name: id,
  role: "member",
  memberCount: 1,
  isDefault,
  permissions: {
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
  },
});

beforeEach(async () => {
  window.localStorage.clear();
  activeWorkspace.__resetActiveWorkspaceForTests();
  __resetTimesheetRowsForTests();
  await activeWorkspace.applyWorkspaceList([workspace("ws-a", true), workspace("ws-b", false)], "u1");
});

afterEach(cleanup);

describe("useTimesheetRows", () => {
  it("keeps each workspace's pinned rows to itself across a switch", async () => {
    const { result } = renderHook(() => useTimesheetRows());
    act(() => result.current.pin({ projectId: "project-in-a", taskId: null }));
    expect(result.current.rows).toEqual([{ projectId: "project-in-a", taskId: null }]);

    await act(async () => {
      await activeWorkspace.switchWorkspace("ws-b", { queryClient: new QueryClient() });
    });
    expect(result.current.rows).toEqual([]);

    await act(async () => {
      await activeWorkspace.switchWorkspace("ws-a", { queryClient: new QueryClient() });
    });
    expect(result.current.rows).toEqual([{ projectId: "project-in-a", taskId: null }]);
  });

  it("hands rows pinned before the workspace key to the first workspace that reads", () => {
    window.localStorage.setItem(
      "trackyourtime.timesheet-rows",
      JSON.stringify([{ projectId: "legacy", taskId: null }]),
    );
    const { result } = renderHook(() => useTimesheetRows());
    expect(result.current.rows).toEqual([{ projectId: "legacy", taskId: null }]);
    expect(window.localStorage.getItem("trackyourtime.timesheet-rows")).toBeNull();
    expect(window.localStorage.getItem("trackyourtime.timesheet-rows:ws-a")).not.toBeNull();
  });
});
