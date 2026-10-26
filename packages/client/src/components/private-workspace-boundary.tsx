"use client";
import * as React from "react";
import { privateViewEpoch, subscribePrivateViewEpoch } from "@/lib/private-view-lifecycle";
import Link from "next/link";
import { privateDataOrigin, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { privateRoutingRequired, privateRoutingRevision, subscribePrivateRoutingRequirement } from "@/lib/private-routing-requirement";
import { whenApiOriginReady } from "@/lib/api-origin";
import { StartupScreen } from "./startup-screen";
import { PrivateDataCard } from "./settings/private-data";
import { Button } from "./ui/button";
import { useT } from "@/i18n/use-t";
import { signOut } from "@/lib/auth-client";
/** Unmount business forms/derived views on lock or verified policy change.
 * Durable ciphertext/outboxes live outside the React tree and stay intact. */
export function PrivateWorkspaceBoundary({ children, userId }: { children: React.ReactNode; userId: string | null }) {
  const t = useT("settings");
  const epoch = React.useSyncExternalStore(subscribePrivateViewEpoch, privateViewEpoch, () => "0");
  React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  const routing = React.useSyncExternalStore(subscribePrivateRoutingRequirement, privateRoutingRevision, () => 0);
  const [retry, setRetry] = React.useState(0);
  const server = privateDataOrigin(), scope = JSON.stringify([server, userId, routing, retry]);
  const [state, setState] = React.useState<{ scope: string; required: boolean; failed: boolean } | null>(null);
  React.useEffect(() => {
    let canceled = false;
    if (userId) void (async () => {
      await whenApiOriginReady();
      const required = await privateRoutingRequired({ server, userId });
      if (!canceled) setState({ scope, required, failed: false });
    })().catch(() => { if (!canceled) setState({ scope, required: true, failed: true }); });
    return () => { canceled = true; };
  }, [scope, server, userId]);
  if (!userId || state?.scope !== scope) return <StartupScreen />;
  if (state.failed || (state.required && !privateSession(userId))) return <main className="mx-auto w-full max-w-3xl space-y-4 p-6" data-testid="private-workspace-locked">
    <h1 className="text-2xl font-semibold">{t(state.failed ? "privateWorkspaceGate.failedTitle" : "privateWorkspaceGate.lockedTitle")}</h1>
    {state.failed ? <p role="alert" className="text-sm">{t("privateWorkspaceGate.failed")}</p> : <>
      <p className="max-w-prose text-sm text-muted-foreground">{t("privateWorkspaceGate.lockedDetail")}</p>
      <PrivateDataCard unlockOnly />
    </>}
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("privateWorkspaceGate.retry")}</Button>
      <Link className="underline underline-offset-4" href="/open-backup/">{t("privateWorkspaceGate.openBackup")}</Link>
      <Button variant="ghost" onClick={() => void signOut()}>{t("privateWorkspaceGate.signOut")}</Button>
    </div>
  </main>;
  return <React.Fragment key={epoch}>{children}</React.Fragment>;
}
