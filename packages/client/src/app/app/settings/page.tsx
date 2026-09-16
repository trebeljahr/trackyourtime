"use client";

import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountSettings } from "@/components/settings/account-settings";
import { ExportPanel } from "@/components/data/export-panel";
import { ImportHistory } from "@/components/data/import-history";
import { ImportPanel } from "@/components/data/import-panel";
import { MoveServerPanel } from "@/components/data/move-server-panel";
import { ApiTokensPanel } from "@/components/settings/api-tokens";
import { AppVersionInfo } from "@/components/settings/app-version";
import { DevicesPanel } from "@/components/settings/devices";
import { ForeignQueuePanel } from "@/components/settings/foreign-queue";
import { WebhooksPanel } from "@/components/settings/webhooks";
import { BillingSettings } from "@/components/settings/billing-settings";
import { GeneralSettings } from "@/components/settings/general-settings";
import { IdleSettingsPanel } from "@/components/settings/idle-settings";
import { MaxDurationSettingsPanel } from "@/components/settings/max-duration-settings";
import { useWorkspaceSettings } from "@/components/settings/use-workspace-settings";
import { WorkspaceTab } from "@/components/settings/workspace-tab";
import { useLocale } from "@/i18n/locale-store";
import { useT } from "@/i18n/use-t";

const TABS = [
  "general",
  "workspace",
  "billing",
  "idle",
  "limits",
  "data",
  "devices",
  "integrations",
  "account",
] as const;

const TAB_VALUES = new Set<string>(TABS);

export default function SettingsPage() {
  // One controller for the whole screen: General, Billing, Idle and Limits
  // all write through the same optimistic `settings.update` path.
  const t = useT("settings");
  const controller = useWorkspaceSettings();
  const [tab, setTab] = React.useState("general");

  // `?tab=data` so anything that wants to send somebody here — the empty
  // tracker's "import your history" — can land on the right panel. Read from
  // `location` in an effect rather than with `useSearchParams`, which forces
  // the whole page into a Suspense boundary under the static export.
  React.useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested && TAB_VALUES.has(requested)) setTab(requested);
  }, []);

  // The tab list scrolls sideways on a phone, and a longer language pushes a
  // tab opened by `?tab=` past the edge — so bring the active one into view,
  // again once the language switch has changed every tab's width.
  const locale = useLocale();
  const tabsRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const list = tabsRef.current;
    const active = list?.querySelector<HTMLElement>(`[data-testid="settings-tab-${tab}"]`);
    if (!list || !active) return;
    // Positions inside the scrolled content, independent of offsetParent.
    const left =
      active.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    const right = left + active.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = right - list.clientWidth;
    }
  }, [tab, locale]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6" data-testid="settings-page">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{t("page.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("page.description")}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList
          ref={tabsRef}
          className="w-full justify-start overflow-x-auto"
          data-testid="settings-tabs"
        >
          {TABS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              data-testid={`settings-tab-${value}`}
            >
              {t(`page.tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general" data-testid="settings-panel-general">
          <GeneralSettings controller={controller} />
        </TabsContent>
        <TabsContent value="workspace" data-testid="settings-panel-workspace">
          <WorkspaceTab />
        </TabsContent>
        <TabsContent value="billing" data-testid="settings-panel-billing">
          <BillingSettings controller={controller} />
        </TabsContent>
        <TabsContent value="idle" data-testid="settings-panel-idle">
          <IdleSettingsPanel controller={controller} />
        </TabsContent>
        <TabsContent value="limits" data-testid="settings-panel-limits">
          <MaxDurationSettingsPanel controller={controller} />
        </TabsContent>
        <TabsContent
          value="data"
          className="space-y-6"
          data-testid="settings-panel-data"
        >
          <ImportPanel />
          <ImportHistory />
          <ExportPanel />
          <MoveServerPanel />
        </TabsContent>
        <TabsContent
          value="devices"
          className="space-y-6"
          data-testid="settings-panel-devices"
        >
          <DevicesPanel />
          {/* Renders nothing unless this device is holding somebody else's
              unsynced work. It belongs beside the sessions rather than under
              Data, which is about the workspace, not about this device. */}
          <ForeignQueuePanel />
        </TabsContent>
        <TabsContent
          value="integrations"
          className="space-y-6"
          data-testid="settings-panel-integrations"
        >
          <ApiTokensPanel />
          <WebhooksPanel />
        </TabsContent>
        <TabsContent value="account" data-testid="settings-panel-account">
          <AccountSettings onShowExport={() => setTab("data")} />
        </TabsContent>
      </Tabs>

      <AppVersionInfo />
    </div>
  );
}
