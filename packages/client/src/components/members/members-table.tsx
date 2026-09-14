"use client";

import * as React from "react";
import type {
  InvitableRole,
  WorkspaceMemberRow,
  WorkspacePermissions,
} from "@starter/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  controlsForRow,
  ownerCountOf,
} from "@/components/members/member-rules";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";

export type VisibilityPatch = {
  canViewOthersTime?: boolean;
  canViewOthersMoney?: boolean;
};

export type MembersTableProps = {
  rows: readonly WorkspaceMemberRow[];
  permissions: WorkspacePermissions;
  /** The row a mutation is in flight for; its controls are disabled meanwhile. */
  busyMemberId: string | null;
  onRoleChange: (row: WorkspaceMemberRow, role: InvitableRole) => void;
  onVisibilityChange: (row: WorkspaceMemberRow, patch: VisibilityPatch) => void;
  /** Asks for confirmation; nothing is sent from the table itself. */
  onRemove: (row: WorkspaceMemberRow) => void;
  /** Asks for confirmation; nothing is sent from the table itself. */
  onTransfer: (row: WorkspaceMemberRow) => void;
};

export const NATIVE_SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Everyone in the workspace, with the controls the viewer may use on each.
 *
 * A flag the viewer cannot change is shown as text, not as a disabled switch:
 * a greyed-out toggle reads as "temporarily unavailable" and invites a second
 * try, where the truth is "not yours to change".
 */
export function MembersTable({
  rows,
  permissions,
  busyMemberId,
  onRoleChange,
  onVisibilityChange,
  onRemove,
  onTransfer,
}: MembersTableProps): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const format = useFormat();
  const ownerCount = ownerCountOf(rows);

  const flagText = (row: WorkspaceMemberRow, value: boolean): string =>
    row.role === "owner" || value ? tc("answers.yes") : tc("answers.no");

  return (
    <div className="overflow-x-auto" data-testid="members-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("table.name")}</TableHead>
            <TableHead>{t("table.role")}</TableHead>
            <TableHead>{t("table.time")}</TableHead>
            <TableHead>{t("table.money")}</TableHead>
            <TableHead>{t("table.joined")}</TableHead>
            <TableHead className="text-right">{t("table.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const controls = controlsForRow(permissions, row, ownerCount);
            const busy = busyMemberId === row.memberId;
            const id = row.memberId;
            return (
              <TableRow key={id} data-testid={`member-row-${id}`} data-role={row.role}>
                <TableCell>
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 font-medium">
                      <span className="truncate" data-testid={`member-name-${id}`}>
                        {row.name}
                      </span>
                      {row.isSelf ? (
                        <Badge variant="secondary" data-testid={`member-self-${id}`}>
                          {t("table.you")}
                        </Badge>
                      ) : null}
                    </span>
                    <span
                      className="truncate text-xs text-muted-foreground"
                      data-testid={`member-email-${id}`}
                    >
                      {row.email}
                    </span>
                  </div>
                </TableCell>

                <TableCell>
                  {controls.roleSelect ? (
                    <select
                      className={NATIVE_SELECT_CLASS}
                      value={row.role}
                      disabled={busy}
                      aria-label={t("table.roleOf", { name: row.name })}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next === "admin" || next === "member") onRoleChange(row, next);
                      }}
                      data-testid={`member-role-select-${id}`}
                    >
                      {/* The current owner value is listed so the select can
                          show it, but it is never choosable: ownership only
                          moves by transfer. */}
                      {row.role === "owner" ? (
                        <option value="owner" disabled>
                          {t("roles.owner")}
                        </option>
                      ) : null}
                      <option value="admin">{t("roles.admin")}</option>
                      <option value="member">{t("roles.member")}</option>
                    </select>
                  ) : (
                    <span data-testid={`member-role-${id}`}>{t(`roles.${row.role}`)}</span>
                  )}
                </TableCell>

                <TableCell>
                  {controls.timeToggle ? (
                    <Switch
                      checked={row.canViewOthersTime}
                      disabled={busy}
                      aria-label={t("table.timeOf", { name: row.name })}
                      onCheckedChange={(checked) =>
                        onVisibilityChange(row, { canViewOthersTime: checked })
                      }
                      data-testid={`member-time-toggle-${id}`}
                    />
                  ) : (
                    <span
                      title={row.role === "owner" ? t("table.ownerSeesAll") : undefined}
                      data-testid={`member-time-value-${id}`}
                    >
                      {flagText(row, row.canViewOthersTime)}
                    </span>
                  )}
                </TableCell>

                <TableCell>
                  {controls.moneyToggle ? (
                    <Switch
                      checked={row.canViewOthersMoney}
                      disabled={busy}
                      aria-label={t("table.moneyOf", { name: row.name })}
                      onCheckedChange={(checked) =>
                        onVisibilityChange(row, { canViewOthersMoney: checked })
                      }
                      data-testid={`member-money-toggle-${id}`}
                    />
                  ) : (
                    <span
                      title={row.role === "owner" ? t("table.ownerSeesAll") : undefined}
                      data-testid={`member-money-value-${id}`}
                    >
                      {flagText(row, row.canViewOthersMoney)}
                    </span>
                  )}
                </TableCell>

                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {format.date(row.joinedAt, "medium")}
                </TableCell>

                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {controls.transfer ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => onTransfer(row)}
                        data-testid={`member-transfer-${id}`}
                      >
                        {t("table.makeOwner")}
                      </Button>
                    ) : null}
                    {controls.remove ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        className="text-destructive"
                        onClick={() => onRemove(row)}
                        data-testid={`member-remove-${id}`}
                      >
                        {t("table.remove")}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
