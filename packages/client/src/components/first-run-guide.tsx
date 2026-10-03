"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Circle, X } from "lucide-react";
import {
  canUseInvoices,
  isIdentityEmpty,
  isPostalAddressMissing,
  normalizeIssuer,
} from "@starter/shared";
import { memoryStorage, webStorage, type KeyValueStorage } from "@starter/core";

import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useApiOrigin } from "@/hooks/use-api-origin";
import { useFormatSettings } from "@/lib/format";
import { useT } from "@/i18n/use-t";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { preferencesStorage, shouldUseNativeStorage } from "@/mobile/preferences-storage";
import { trpc } from "@/lib/trpc";
import { CLIENT_LIST_INPUT, PROJECT_LIST_INPUT } from "@/components/catalog/types";
import { INVOICE_LIST_INPUT } from "@/components/invoices/types";

export const firstRunStorageKey = (
  server: string,
  userId: string,
  workspaceId: string,
): string =>
  `trackyourtime.first-run-status:${encodeURIComponent(server)}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;

const makeStorage = (): KeyValueStorage => {
  if (typeof window === "undefined") return memoryStorage();
  try {
    if (shouldUseNativeStorage()) return preferencesStorage();
    return webStorage(window.localStorage);
  } catch {
    return memoryStorage();
  }
};

let storage: KeyValueStorage | null = null;
const getStorage = (): KeyValueStorage => {
  storage ??= makeStorage();
  return storage;
};

type GuideStatus = "enrolled" | "tracking" | "billing" | "dismissed" | "completed";
type LoadedGuideStatus = { scope: string; status: GuideStatus | null };

const parseGuideStatus = (value: string | null): GuideStatus | null =>
  value === "enrolled" ||
  value === "tracking" ||
  value === "billing" ||
  value === "dismissed" ||
  value === "completed"
    ? value
    : null;

type ChecklistItemProps = {
  complete: boolean;
  label: string;
  href: string;
};

function ChecklistItem({ complete, label, href }: ChecklistItemProps): React.JSX.Element {
  return (
    <li className="flex min-w-0 items-start gap-2 text-sm">
      {complete ? (
        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <Link
        href={href}
        className={complete ? "min-w-0 text-muted-foreground line-through" : "min-w-0 underline underline-offset-4"}
        data-complete={complete ? "true" : "false"}
      >
        {label}
      </Link>
    </li>
  );
}

/** A small, optional guide enrolled once for an empty workspace. */
export function FirstRunGuide({
  hasAnyEntry,
  canEnroll,
}: {
  /** Any history visible to this viewer; once enrolled, it also marks the first-entry step. */
  hasAnyEntry: boolean;
  /** True only after the initial history query confirms there are no visible entries. */
  canEnroll: boolean;
}): React.JSX.Element | null {
  const t = useT("tracker");
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const apiOrigin = useApiOrigin();
  const format = useFormatSettings();
  const server = getAbsoluteApiOrigin();
  const workspaceId = workspace?.id ?? null;
  const scope =
    apiOrigin.ready && user && workspaceId
      ? firstRunStorageKey(server, user.id, workspaceId)
      : null;
  const canUseBilling = Boolean(
    workspace &&
      canUseInvoices(workspace.role, {
        userId: user?.id ?? "",
        canViewOthersTime: workspace.permissions.viewOthersTime,
        canViewOthersMoney: workspace.permissions.viewOthersMoney,
      }),
  );
  const canConfirmEmptyWorkspace = Boolean(
    workspace && (workspace.memberCount === 1 || workspace.permissions.viewOthersTime),
  );
  const [loaded, setLoaded] = React.useState<LoadedGuideStatus | null>(null);
  const loadedScope = loaded?.scope ?? null;
  const statusForScope = loadedScope === scope ? loaded?.status ?? null : null;
  const shouldLoadChecklist =
    scope !== null &&
    (statusForScope === "enrolled" ||
      statusForScope === "tracking" ||
      statusForScope === "billing" ||
      (canEnroll && !hasAnyEntry && canConfirmEmptyWorkspace));
  const shouldLoadBilling =
    shouldLoadChecklist &&
    canUseBilling &&
    (statusForScope === "enrolled" || statusForScope === "billing");
  const projects = trpc.projects.list.useQuery(PROJECT_LIST_INPUT, {
    enabled: shouldLoadChecklist,
    staleTime: 30_000,
  });
  const clients = trpc.clients.list.useQuery(CLIENT_LIST_INPUT, {
    enabled: shouldLoadBilling,
    staleTime: 30_000,
  });
  const businessProfile = trpc.settings.businessProfile.useQuery(undefined, {
    enabled: shouldLoadBilling,
    staleTime: 30_000,
  });
  const invoices = trpc.invoices.list.useQuery(INVOICE_LIST_INPUT, {
    enabled: shouldLoadBilling,
    staleTime: 30_000,
  });
  React.useEffect(() => {
    let active = true;
    if (scope === null) return () => { active = false; };
    void getStorage().getItem(scope).then((value) => {
      if (!active) return;
      setLoaded({ scope, status: parseGuideStatus(value) });
    });
    return () => { active = false; };
  }, [scope]);

  React.useEffect(() => {
    if (scope === null || loadedScope !== scope || statusForScope !== null || hasAnyEntry || !canEnroll || !canConfirmEmptyWorkspace) return;
    let active = true;
    const markEnrolled = (): void => {
      if (!active) return;
      setLoaded((current) =>
        current?.scope === scope && current.status === null
          ? { scope, status: "enrolled" }
          : current,
      );
    };
    void getStorage().setItem(scope, "enrolled").then(markEnrolled, markEnrolled);
    return () => { active = false; };
  }, [canConfirmEmptyWorkspace, canEnroll, hasAnyEntry, loadedScope, scope, statusForScope]);

  const projectRows = projects.data ?? [];
  const profile = businessProfile.data ?? null;
  const issuer = profile ? normalizeIssuer(profile) : null;
  const hasRate =
    (format.settings.memberHourlyRate ?? format.settings.defaultHourlyRate) > 0 ||
    projectRows.some((project) => project.hourlyRate !== null && project.hourlyRate > 0);
  const hasBusinessDetails = Boolean(
    profile && issuer && !isIdentityEmpty(issuer) && !isPostalAddressMissing(profile),
  );
  const billingDataLoaded =
    clients.data !== undefined &&
    businessProfile.data !== undefined &&
    invoices.data !== undefined;
  const billingComplete =
    billingDataLoaded &&
    (clients.data?.length ?? 0) > 0 &&
    projectRows.length > 0 &&
    hasRate &&
    hasBusinessDetails &&
    (invoices.data?.invoices.length ?? 0) > 0;
  const complete =
    statusForScope === "tracking"
      ? hasAnyEntry
      : statusForScope === "billing" && billingComplete;

  React.useEffect(() => {
    if (
      scope === null ||
      loadedScope !== scope ||
      (statusForScope !== "tracking" && statusForScope !== "billing") ||
      !complete
    ) return;
    let active = true;
    const completedPath = statusForScope;
    const markCompleted = (): void => {
      if (!active) return;
      setLoaded((current) =>
        current?.scope === scope && current.status === completedPath
          ? { scope, status: "completed" }
          : current,
      );
    };
    void getStorage().setItem(scope, "completed").then(markCompleted, markCompleted);
    return () => { active = false; };
  }, [complete, loadedScope, scope, statusForScope]);

  const setGuideStatus = (next: "enrolled" | "tracking" | "billing" | "dismissed"): void => {
    if (scope === null || loadedScope !== scope) return;
    setLoaded({ scope, status: next });
    void getStorage().setItem(scope, next);
  };

  const showTracking = statusForScope === "enrolled" || statusForScope === "tracking";
  const showBilling =
    canUseBilling && (statusForScope === "enrolled" || statusForScope === "billing") && billingDataLoaded;

  if (
    scope === null ||
    loadedScope !== scope ||
    statusForScope === null ||
    statusForScope === "dismissed" ||
    statusForScope === "completed" ||
    complete ||
    projects.data === undefined
  ) {
    return null;
  }

  return (
    <Card className="relative" data-testid="first-run-guide">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-8"
        onClick={() => setGuideStatus("dismissed")}
        aria-label={t("firstRun.dismiss")}
        data-testid="first-run-dismiss"
      >
        <X className="size-4" />
      </Button>
      <CardHeader className="pb-3 pr-12">
        <CardTitle className="text-base">{t("firstRun.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("firstRun.description")}</p>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {statusForScope !== "enrolled" ? (
          <div className="flex justify-end sm:col-span-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setGuideStatus("enrolled")}>
              {t("firstRun.changePath")}
            </Button>
          </div>
        ) : null}
        {showTracking ? (
          <section className="grid content-start gap-2" aria-labelledby="first-run-track-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="first-run-track-title" className="text-sm font-semibold">{t("firstRun.trackPath")}</h3>
              {statusForScope === "enrolled" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setGuideStatus("tracking")} data-testid="first-run-select-tracking">
                  {t("firstRun.chooseTracking")}
                </Button>
              ) : null}
            </div>
            <ul className="grid gap-2">
              <ChecklistItem complete={hasAnyEntry} label={t("firstRun.firstEntry")} href="#tracker-composer" />
              <ChecklistItem complete={projectRows.length > 0} label={t("firstRun.optionalProject")} href="/app/projects" />
            </ul>
          </section>
        ) : null}
        {showBilling ? (
          <section className="grid content-start gap-2" aria-labelledby="first-run-billing-title" data-testid="first-run-billing">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="first-run-billing-title" className="text-sm font-semibold">{t("firstRun.billingPath")}</h3>
              {statusForScope === "enrolled" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setGuideStatus("billing")} data-testid="first-run-select-billing">
                  {t("firstRun.chooseBilling")}
                </Button>
              ) : null}
            </div>
            <ul className="grid gap-2">
              <ChecklistItem complete={(clients.data?.length ?? 0) > 0 && projectRows.length > 0} label={t("firstRun.clientProject")} href="/app/clients" />
              <ChecklistItem complete={hasRate} label={t("firstRun.rate")} href="/app/projects" />
              <ChecklistItem complete={hasBusinessDetails} label={t("firstRun.businessDetails")} href="/app/settings?tab=billing" />
              <ChecklistItem complete={(invoices.data?.invoices.length ?? 0) > 0} label={t("firstRun.firstInvoice")} href="/app/invoices" />
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
