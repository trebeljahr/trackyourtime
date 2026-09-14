"use client";

import * as React from "react";
import { EyeOff } from "lucide-react";

import { canReportByMember } from "@/components/members/member-rules";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/reports/multi-select";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

/**
 * Whether this viewer is offered the member filter and "group by member".
 * See `canReportByMember` for who, and why the server makes it safe either way.
 */
export const useMemberReporting = (): boolean =>
  canReportByMember(useActiveWorkspace().workspace);

export type MemberFilterProps = {
  value: string[];
  onChange: (ids: string[]) => void;
};

/**
 * Narrow a report to some members' time, by user id.
 *
 * The options are `members.list` — the people in the workspace, which any
 * member may list. Choosing a colleague is a request, not a grant: the server
 * intersects `memberIds` with the caller's author scope, so somebody who may
 * only see their own time gets an empty report for a colleague, never the
 * colleague's hours. The filter is only rendered where `useMemberReporting`
 * says so.
 */
export function MemberFilter({ value, onChange }: MemberFilterProps): React.JSX.Element {
  const t = useT("members");
  const membersQuery = trpc.members.list.useQuery(undefined, { staleTime: 60_000 });

  const options = React.useMemo<MultiSelectOption[]>(
    () =>
      (membersQuery.data ?? []).map((member) => ({
        value: member.userId,
        label: member.name,
        keywords: [member.email],
      })),
    [membersQuery.data]
  );

  return (
    <MultiSelect
      label={t("reports.members")}
      options={options}
      value={value}
      onChange={onChange}
      emptyText={t("reports.empty")}
      searchPlaceholder={t("reports.search")}
      className="w-[9.5rem]"
      testId="filter-members"
    />
  );
}

/**
 * Said where the money would be, when the server withheld it.
 *
 * `moneyVisible: false` means the report spans colleagues' time and the
 * viewer may not see what it is worth. The figures already read as dashes;
 * this says the dashes are a permission, not a missing rate.
 */
export function MoneyHiddenNote({
  moneyVisible,
}: {
  moneyVisible: boolean | undefined;
}): React.JSX.Element | null {
  const t = useT("members");
  if (moneyVisible !== false) return null;
  return (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      role="note"
      data-testid="report-money-hidden"
    >
      <EyeOff className="size-4 shrink-0" />
      {t("reports.moneyHidden")}
    </p>
  );
}
