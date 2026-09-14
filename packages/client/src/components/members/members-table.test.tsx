// @vitest-environment jsdom
/**
 * The Members table draws exactly the controls the server's permission matrix
 * would accept, for each role looking at each row. The server refuses anything
 * else regardless; what these pin is that nobody is offered a control whose
 * only possible outcome is a refusal — and, above all, that nobody is offered
 * a control over their own row.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { permissionsFor, type WorkspaceRole } from "@starter/shared";

import { MembersTable, type MembersTableProps } from "./members-table";
import { controlsForRow, leaveBlockFor, canReportByMember, pickActiveWorkspace } from "./member-rules";
import { memberRow, teamRows, workspaceFor } from "./member-fixtures";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

afterEach(cleanup);

const renderTable = (role: WorkspaceRole, overrides: Partial<MembersTableProps> = {}) => {
  const props: MembersTableProps = {
    rows: teamRows(role),
    permissions: permissionsFor(role, { canViewOthersTime: false, canViewOthersMoney: false }),
    busyMemberId: null,
    onRoleChange: vi.fn(),
    onVisibilityChange: vi.fn(),
    onRemove: vi.fn(),
    onTransfer: vi.fn(),
    ...overrides,
  };
  render(<MembersTable {...props} />);
  return props;
};

const has = (testId: string): boolean => screen.queryByTestId(testId) !== null;

const controlIds = (memberId: string) => ({
  role: `member-role-select-${memberId}`,
  time: `member-time-toggle-${memberId}`,
  money: `member-money-toggle-${memberId}`,
  remove: `member-remove-${memberId}`,
  transfer: `member-transfer-${memberId}`,
});

const expectNoControls = (memberId: string): void => {
  for (const id of Object.values(controlIds(memberId))) {
    expect(has(id), id).toBe(false);
  }
};

describe("MembersTable as owner", () => {
  it("offers role, both flags, remove and transfer on non-owner rows", () => {
    renderTable("owner");
    for (const memberId of ["admin", "member"]) {
      const ids = controlIds(memberId);
      expect(has(ids.role)).toBe(true);
      expect(has(ids.time)).toBe(true);
      expect(has(ids.money)).toBe(true);
      expect(has(ids.remove)).toBe(true);
      expect(has(ids.transfer)).toBe(true);
    }
  });

  it("draws no control on their own row", () => {
    renderTable("owner");
    expectNoControls("owner");
    expect(screen.getByTestId("member-self-owner")).toBeInTheDocument();
  });

  it("never offers owner as a choosable role", () => {
    renderTable("owner");
    const select = screen.getByTestId("member-role-select-member") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["admin", "member"]);
  });

  it("sends role and flag changes for the row, with no workspace id", () => {
    const props = renderTable("owner");
    fireEvent.change(screen.getByTestId("member-role-select-member"), {
      target: { value: "admin" },
    });
    expect(props.onRoleChange).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member" }),
      "admin",
    );
    fireEvent.click(screen.getByTestId("member-money-toggle-admin"));
    expect(props.onVisibilityChange).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "admin" }),
      { canViewOthersMoney: true },
    );
  });

  it("asks the screen to confirm rather than removing or transferring itself", () => {
    const props = renderTable("owner");
    fireEvent.click(screen.getByTestId("member-remove-member"));
    fireEvent.click(screen.getByTestId("member-transfer-admin"));
    expect(props.onRemove).toHaveBeenCalledWith(expect.objectContaining({ memberId: "member" }));
    expect(props.onTransfer).toHaveBeenCalledWith(expect.objectContaining({ memberId: "admin" }));
  });

  it("lets a co-owner be demoted or removed only while another owner remains", () => {
    const rows = [
      ...teamRows("owner"),
      memberRow({ memberId: "owner2", role: "owner", canViewOthersTime: true, canViewOthersMoney: true }),
    ];
    renderTable("owner", { rows });
    const ids = controlIds("owner2");
    expect(has(ids.role)).toBe(true);
    expect(has(ids.remove)).toBe(true);
    // Owner flags are forced on; transferring to an owner is meaningless.
    expect(has(ids.time)).toBe(false);
    expect(has(ids.money)).toBe(false);
    expect(has(ids.transfer)).toBe(false);
  });
});

describe("MembersTable as admin", () => {
  it("offers the time toggle and remove on plain members only", () => {
    renderTable("admin");
    const member = controlIds("member");
    expect(has(member.time)).toBe(true);
    expect(has(member.remove)).toBe(true);
    // No role select and no money toggle anywhere — those are the owner's.
    expect(has(member.role)).toBe(false);
    expect(has(member.money)).toBe(false);
    expect(has(member.transfer)).toBe(false);
  });

  it("draws no control on the owner row or their own", () => {
    renderTable("admin");
    expectNoControls("owner");
    expectNoControls("admin");
  });

  it("shows money visibility as text, never as a disabled switch", () => {
    renderTable("admin");
    expect(screen.getByTestId("member-money-value-member")).toHaveTextContent("No");
    expect(screen.getByTestId("member-money-value-owner")).toHaveTextContent("Yes");
  });
});

describe("MembersTable as member", () => {
  it("is read-only", () => {
    renderTable("member");
    for (const memberId of ["owner", "admin", "member"]) expectNoControls(memberId);
    expect(screen.getByTestId("member-role-owner")).toHaveTextContent("Owner");
    expect(screen.getByTestId("member-email-admin")).toHaveTextContent("admin@example.com");
  });
});

describe("member rules", () => {
  it("never grants controls over the viewer's own row, whatever the permissions", () => {
    const self = memberRow({ memberId: "me", role: "member", isSelf: true });
    const all = permissionsFor("owner", { canViewOthersTime: true, canViewOthersMoney: true });
    expect(Object.values(controlsForRow(all, self, 1)).some(Boolean)).toBe(false);
  });

  it("blocks leaving for the last owner and for the only member", () => {
    expect(leaveBlockFor("owner", teamRows("owner"))).toBe("transfer-ownership-first");
    expect(leaveBlockFor("owner", [memberRow({ memberId: "me", role: "owner", isSelf: true })])).toBe(
      "workspace-has-no-other-members",
    );
    expect(leaveBlockFor("admin", teamRows("admin"))).toBeNull();
    expect(leaveBlockFor("member", teamRows("member"))).toBeNull();
  });

  it("offers member reporting to people who manage or see a shared workspace", () => {
    expect(canReportByMember(null)).toBe(false);
    expect(canReportByMember(workspaceFor("owner"))).toBe(true);
    expect(canReportByMember(workspaceFor("admin"))).toBe(true);
    expect(canReportByMember(workspaceFor("admin", { memberCount: 1 }))).toBe(false);
    expect(canReportByMember(workspaceFor("member"))).toBe(false);
    expect(
      canReportByMember(
        workspaceFor("member", {}, { canViewOthersTime: true, canViewOthersMoney: false }),
      ),
    ).toBe(true);
  });

  it("picks the session default workspace, else the first", () => {
    const a = workspaceFor("owner", { id: "a", isDefault: false });
    const b = workspaceFor("member", { id: "b", isDefault: true });
    expect(pickActiveWorkspace([a, b])?.id).toBe("b");
    expect(pickActiveWorkspace([a])?.id).toBe("a");
    expect(pickActiveWorkspace([])).toBeNull();
    expect(pickActiveWorkspace(undefined)).toBeNull();
  });
});
