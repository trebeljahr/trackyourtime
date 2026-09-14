"use client";

import * as React from "react";
import Link from "next/link";
import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useT } from "@/i18n/use-t";

/**
 * Settings → Workspace: which workspace this app is in, the viewer's role
 * there, and the way to the Members screen. The membership controls
 * themselves live on /members, reachable from the nav too.
 */
export function WorkspaceTab(): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const { workspace, isLoading, isError, refetch } = useActiveWorkspace();

  if (isLoading) {
    return (
      <Card data-testid="workspace-tab-loading">
        <CardContent className="space-y-3 pt-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-5 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (isError || workspace === null) {
    return (
      <Card data-testid="workspace-tab-error">
        <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-6">
          <p className="text-sm text-destructive">{t("workspaceTab.loadError")}</p>
          <Button type="button" variant="outline" size="sm" onClick={refetch}>
            {tc("actions.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="workspace-tab">
      <CardHeader>
        <CardTitle className="text-base">{t("workspaceTab.title")}</CardTitle>
        <CardDescription>{t("workspaceTab.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">{t("workspaceTab.name")}</dt>
          <dd className="font-medium" data-testid="workspace-tab-name">
            {workspace.name}
          </dd>
          <dt className="text-muted-foreground">{t("workspaceTab.yourRole")}</dt>
          <dd data-testid="workspace-tab-role">{t(`roles.${workspace.role}`)}</dd>
          <dt className="text-muted-foreground">{t("page.title")}</dt>
          <dd data-testid="workspace-tab-count">
            {t("workspaceTab.count", { count: workspace.memberCount })}
          </dd>
        </dl>
        <Button asChild variant="outline">
          <Link href="/members" data-testid="workspace-tab-members-link">
            <Users className="size-4" />
            {workspace.permissions.inviteMembers
              ? t("workspaceTab.manage")
              : t("workspaceTab.view")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
