"use client";
import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { privateViewMountKey, subscribePrivateViewEpoch } from "@/lib/private-view-lifecycle";
import { privateAccountId, privateDataOrigin, privateOperationScope, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { privateRoutingRevision, subscribePrivateRoutingRequirement } from "@/lib/private-routing-requirement";
import { confirmStandardDeviceAccess, privateDeviceAccessRevision, subscribePrivateDeviceAccess } from "@/lib/private-device-access";
import { readPrivateDeviceAccessState, type PrivateDeviceAccessState } from "@/lib/private-device-access-state";
import { isPrivateContentRefusal } from "@/lib/private-content-error";
import { whenApiOriginReady } from "@/lib/api-origin";
import { StartupScreen } from "./startup-screen";
import { PrivateDataCard } from "./settings/private-data";
import { PrivateDeviceUnlock } from "./settings/private-device-unlock";
import { Button } from "./ui/button";
import { useT } from "@/i18n/use-t";
import { signOut } from "@/lib/auth-client";
/** Keep business forms behind local device enrollment. A device with no stored
 * decision enrolls in standard storage by itself: nobody is asked to choose a
 * storage mode. `confirmStandardDeviceAccess` refuses an account whose routing
 * requires private keys, which then shows the unlock controls. Unlock controls
 * retain their component identity across policy writes, so persisting an
 * approved checkpoint cannot unmount and cancel its own in-flight confirmation. */
export function PrivateWorkspaceBoundary({ children, userId }: { children: React.ReactNode; userId: string | null }) {
  const t = useT("settings"), queryClient = useQueryClient();
  // Forms remount on every private view change except the page's first
  // private read, which only re-reads (query-client.ts), so an open dialog stays.
  const epoch = React.useSyncExternalStore(subscribePrivateViewEpoch, privateViewMountKey, () => "0");
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  const routing = React.useSyncExternalStore(subscribePrivateRoutingRequirement, privateRoutingRevision, () => 0);
  const device = React.useSyncExternalStore(subscribePrivateDeviceAccess, privateDeviceAccessRevision, () => 0);
  const [retry, setRetry] = React.useState(0), [controlsScope, setControlsScope] = React.useState("");
  const server = privateDataOrigin(), identityScope = JSON.stringify([server, userId]);
  const scope = JSON.stringify([identityScope, routing, device, retry]);
  const [state, setState] = React.useState<{ scope: string; status: PrivateDeviceAccessState | "failed"; version: number } | null>(null);
  React.useEffect(() => {
    let canceled = false;
    if (userId) void (async () => {
      await whenApiOriginReady(); const status = await readPrivateDeviceAccessState(userId);
      if (!canceled) {
        if (status === "locked" || status === "inventory" || status === "ready") setControlsScope(identityScope);
        setState({ scope, status, version });
      }
    })().catch(() => { if (!canceled) setState({ scope, status: "failed", version }); });
    return () => { canceled = true; };
  }, [scope, server, userId, version, identityScope]);
  const privateState = state?.status === "locked" || state?.status === "inventory" || state?.status === "ready";
  const checking = !userId || state?.scope !== scope || (privateState && state.version !== version);
  const ready = !checking && (state.status === "standard" || state.status === "ready");
  React.useEffect(() => {
    if (ready) void queryClient.resetQueries({ predicate: (query) => isPrivateContentRefusal(query.state.error) });
  }, [ready, queryClient, identityScope]);
  const enrolling = !checking && state.status === "unknown";
  React.useEffect(() => {
    if (!enrolling || !userId) return;
    let canceled = false;
    const captured = privateOperationScope(userId), at = privateSessionVersion();
    const current = () => { if (canceled) return false; try { captured(); return privateAccountId() === userId && privateDataOrigin() === server && privateSessionVersion() === at; } catch { return false; } };
    // Success publishes a device-access change, which re-reads the state as "standard".
    // A refusal (private routing appeared meanwhile, storage denied) re-reads too, and
    // a second refusal on the same scope shows the failure with its retry.
    void confirmStandardDeviceAccess({ server, userId }, current).catch(() => {
      if (current()) setState((previous) => previous && previous.scope === scope ? { ...previous, status: "failed" } : previous);
    });
    return () => { canceled = true; };
  }, [enrolling, userId, server, scope]);
  const controls = controlsScope === identityScope;
  return <>
    {ready && <React.Fragment key={epoch}>{children}</React.Fragment>}
    <main hidden={ready} className="mx-auto w-full max-w-3xl space-y-5 p-6" data-testid="private-workspace-locked">
      <div>
        {checking || enrolling ? <StartupScreen /> : <>
          <h1 className="text-2xl font-semibold">{t(state.status === "failed" ? "privateWorkspaceGate.failedTitle" : state.status === "inventory" ? "privateWorkspaceGate.inventoryTitle" : "privateWorkspaceGate.lockedTitle")}</h1>
          <p className="mt-3 max-w-prose text-sm text-muted-foreground" role={state.status === "failed" ? "alert" : undefined}>{t(state.status === "failed" ? "privateWorkspaceGate.failed" : state.status === "inventory" ? "privateWorkspaceGate.inventoryDetail" : "privateWorkspaceGate.lockedDetail")}</p>
        </>}
      </div>
      <div hidden={checking || enrolling || state?.status === "failed"} className="space-y-4">
        {controls && !ready && userId && <div key={identityScope} className="space-y-4">
          <PrivateDataCard unlockOnly hideDeviceUnlock />
          <PrivateDeviceUnlock userId={userId} />
        </div>}
      </div>
      {!checking && !enrolling && <div className="flex flex-wrap items-center gap-4 text-sm">
        <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("privateWorkspaceGate.retry")}</Button>
        <Link className="underline underline-offset-4" href="/open-backup/">{t("privateWorkspaceGate.openBackup")}</Link>
        <Button variant="ghost" onClick={() => void signOut()}>{t("privateWorkspaceGate.signOut")}</Button>
      </div>}
    </main>
  </>;
}
