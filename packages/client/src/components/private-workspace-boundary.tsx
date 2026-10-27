"use client";
import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { privateViewEpoch, subscribePrivateViewEpoch } from "@/lib/private-view-lifecycle";
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
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { useT } from "@/i18n/use-t";
import { signOut } from "@/lib/auth-client";
/** Keep business forms behind local device enrollment. Unlock controls retain
 * their component identity across policy writes, so persisting an approved
 * checkpoint cannot unmount and cancel its own in-flight confirmation. */
export function PrivateWorkspaceBoundary({ children, userId }: { children: React.ReactNode; userId: string | null }) {
  const t = useT("settings"), queryClient = useQueryClient();
  const epoch = React.useSyncExternalStore(subscribePrivateViewEpoch, privateViewEpoch, () => "0");
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  const routing = React.useSyncExternalStore(subscribePrivateRoutingRequirement, privateRoutingRevision, () => 0);
  const device = React.useSyncExternalStore(subscribePrivateDeviceAccess, privateDeviceAccessRevision, () => 0);
  const [retry, setRetry] = React.useState(0), [controlsScope, setControlsScope] = React.useState("");
  const [acknowledged, setAcknowledged] = React.useState(""), [saving, setSaving] = React.useState(false), [problem, setProblem] = React.useState("");
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
  const confirmStandard = async () => {
    if (!userId || acknowledged !== identityScope || saving) return;
    const captured = privateOperationScope(userId), at = privateSessionVersion();
    const current = () => { try { captured(); return privateAccountId() === userId && privateDataOrigin() === server && privateSessionVersion() === at; } catch { return false; } };
    setSaving(true); setProblem("");
    try { await confirmStandardDeviceAccess({ server, userId }, current); }
    catch { if (current()) setProblem(identityScope); }
    finally { setSaving(false); }
  };
  const controls = controlsScope === identityScope;
  return <>
    {ready && <React.Fragment key={epoch}>{children}</React.Fragment>}
    <main hidden={ready} className="mx-auto w-full max-w-3xl space-y-5 p-6" data-testid="private-workspace-locked">
      <div>
        {checking ? <StartupScreen /> : <>
          <h1 className="text-2xl font-semibold">{t(state.status === "unknown" ? "privateWorkspaceGate.unknownTitle" : state.status === "failed" ? "privateWorkspaceGate.failedTitle" : state.status === "inventory" ? "privateWorkspaceGate.inventoryTitle" : "privateWorkspaceGate.lockedTitle")}</h1>
          <p className="mt-3 max-w-prose text-sm text-muted-foreground" role={state.status === "failed" ? "alert" : undefined}>{t(state.status === "unknown" ? "privateWorkspaceGate.unknownDetail" : state.status === "failed" ? "privateWorkspaceGate.failed" : state.status === "inventory" ? "privateWorkspaceGate.inventoryDetail" : "privateWorkspaceGate.lockedDetail")}</p>
        </>}
      </div>
      <div hidden={checking || state?.status === "failed"} className="space-y-4">
        {controls && !ready && userId && <div key={identityScope} className="space-y-4">
          <PrivateDataCard unlockOnly hideDeviceUnlock />
          <PrivateDeviceUnlock userId={userId} />
        </div>}
      </div>
      {!checking && state.status === "unknown" && <div className="space-y-5">
        {!controls && <Button variant="outline" onClick={() => setControlsScope(identityScope)}>{t("privateWorkspaceGate.choosePrivate")}</Button>}
        <div className="space-y-3 border-t pt-5">
          <h2 className="font-medium">{t("privateWorkspaceGate.standardTitle")}</h2>
          <p className="max-w-prose text-sm text-muted-foreground">{t("privateWorkspaceGate.standardDetail")}</p>
          <div className="flex items-start gap-3">
            <Checkbox id="standard-device-confirm" checked={acknowledged === identityScope} disabled={saving} onCheckedChange={(checked) => setAcknowledged(checked === true ? identityScope : "")} />
            <Label htmlFor="standard-device-confirm" className="max-w-prose text-sm leading-relaxed">{t("privateWorkspaceGate.standardConfirm")}</Label>
          </div>
          <Button variant="outline" className="h-auto max-w-full whitespace-normal text-left" disabled={saving || acknowledged !== identityScope} onClick={() => void confirmStandard()}>{t("privateWorkspaceGate.chooseStandard")}</Button>
          {problem === identityScope && <p role="alert" className="text-sm text-destructive">{t("privateWorkspaceGate.failed")}</p>}
        </div>
      </div>}
      {!checking && <div className="flex flex-wrap items-center gap-4 text-sm">
        <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("privateWorkspaceGate.retry")}</Button>
        <Link className="underline underline-offset-4" href="/open-backup/">{t("privateWorkspaceGate.openBackup")}</Link>
        <Button variant="ghost" onClick={() => void signOut()}>{t("privateWorkspaceGate.signOut")}</Button>
      </div>}
    </main>
  </>;
}
