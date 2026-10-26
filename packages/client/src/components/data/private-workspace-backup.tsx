"use client";
import * as React from "react";
import { RecoveryBackupPausedError } from "@starter/core";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { downloadBlob } from "@/lib/download";
import { privateRecoveryController, type PrivateRecoverySettings } from "@/lib/private-recovery-controller";
import { privateRecoveryMode } from "@/lib/private-recovery-mode";
import { privateDataOrigin, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { chooseRecoveryBackupFolder, supportsRecoveryBackupFolders } from "@/lib/recovery-backup-folder";
import { AutomaticRecoveryBackup } from "./automatic-recovery-backup";
import { PRIVATE_RECOVERY_CHANGED, notePrivateBackupRun, privateBackupRunState, subscribePrivateBackupRun } from "./private-recovery-status";
const subscribeNothing = () => () => {};
export function WorkspaceRecoveryBackup(): React.JSX.Element | null {
  const { user } = useAuth(), { workspace } = useActiveWorkspace();
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  if (!user || !workspace) return null;
  return <SelectBackup key={`${privateDataOrigin()}:${user.id}:${workspace.id}:${version}`} userId={user.id} workspaceId={workspace.id} />;
}
function SelectBackup({ userId, workspaceId }: { userId: string; workspaceId: string }) {
  const t = useT("settings"), unlocked = !!privateSession(userId);
  const [mode, setMode] = React.useState<"loading" | "encrypted" | "standard" | "unenrolled" | "failed">("loading");
  React.useEffect(() => {
    let cancelled = false;
    if (unlocked) void privateRecoveryMode(userId, workspaceId).then((value) => { if (!cancelled) setMode(value); }).catch(() => { if (!cancelled) setMode("failed"); });
    return () => { cancelled = true; };
  }, [userId, workspaceId, unlocked]);
  if (!unlocked || mode === "standard" || mode === "unenrolled") return <AutomaticRecoveryBackup />;
  if (mode === "encrypted") return <PrivateWorkspaceBackup userId={userId} workspaceId={workspaceId} />;
  return mode === "failed" ? <p role="alert" className="text-sm text-destructive">{t("privateBackups.failed")}</p> : null;
}
export function PrivateWorkspaceBackup({ userId, workspaceId }: { userId: string; workspaceId: string }): React.JSX.Element {
  const t = useT("settings"), folders = React.useSyncExternalStore(subscribeNothing, supportsRecoveryBackupFolders, () => false);
  const [settings, setSettings] = React.useState<PrivateRecoverySettings | null>(null), [ready, setReady] = React.useState(false);
  const [secret, setSecret] = React.useState(""), [intervalDays, setIntervalDays] = React.useState<1 | 7>(7), [pending, setPending] = React.useState(false), [failed, setFailed] = React.useState(false);
  const status = React.useSyncExternalStore(subscribePrivateBackupRun, () => privateBackupRunState(userId, workspaceId), () => "idle" as const);
  const account = trpc.privacy.identity.useQuery({ userId }, { enabled: ready && !settings, retry: false });
  const controller = React.useRef<Awaited<ReturnType<typeof privateRecoveryController>> | null>(null), alive = React.useRef(true);
  React.useEffect(() => {
    let cancelled = false; alive.current = true;
    void privateRecoveryController(userId, workspaceId).then(async (next) => {
      if (cancelled) { next.close(); return; } controller.current = next;
      try { const value = await next.read(); if (!cancelled) { setSettings(value); if (value) setIntervalDays(value.intervalDays); setReady(true); } } catch { if (!cancelled) setFailed(true); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    const unsubscribe = subscribePrivateBackupRun(() => { if (controller.current) void controller.current.read().then((value) => { if (!cancelled) setSettings(value); }).catch(() => {}); });
    return () => { cancelled = true; alive.current = false; unsubscribe(); controller.current?.close(); controller.current = null; };
  }, [userId, workspaceId]);
  const run = async (task: () => Promise<void>) => {
    setPending(true); setFailed(false);
    try { await task(); }
    catch (error) { if (alive.current) { if (error instanceof RecoveryBackupPausedError) notePrivateBackupRun(userId, workspaceId, "folder-unavailable"); else { setFailed(true); notePrivateBackupRun(userId, workspaceId, "failed"); } } }
    finally { if (alive.current) { setSecret(""); setPending(false); } }
  };
  const active = () => { if (!alive.current || !controller.current) throw new Error("Private backup screen changed"); return controller.current; };
  const disabled = pending || !ready || (!settings && (!account.data || secret.trim().length !== 43));
  return <section className="space-y-3 border-t pt-4" data-testid="private-workspace-backup">
    <h3 className="text-sm font-medium">{t("privateBackups.title")}</h3>
    <p className="max-w-prose text-sm text-muted-foreground">{t("privateBackups.description")}</p>
    <p className="max-w-prose text-xs text-muted-foreground">{t("privateBackups.limits")}</p>
    {!settings && <div className="max-w-xl space-y-2">
      <p className="text-xs text-muted-foreground">{t("automaticBackups.keyHint")}</p>
      <Label htmlFor="private-backup-key">{t("automaticBackups.recoveryKey")}</Label>
      <Input id="private-backup-key" type="password" autoComplete="off" disabled={pending} value={secret} onChange={(event) => setSecret(event.target.value)} />
    </div>}
    <Button variant="outline" disabled={disabled} onClick={() => void run(async () => {
      const next = active();
      if (!settings) { const value = await next.configure({ recoveryKey: secret, identity: account.data?.identity, intervalDays }); if (!alive.current) return; setSettings(value); }
      const file = await next.download(); if (!alive.current) return;
      downloadBlob(`trackyourtime-private-recovery-${file.header.createdAt.replace(/[:.]/g, "-")}-${file.header.fileId}.tytrecovery`, new Blob([JSON.stringify(file)], { type: "application/json" }));
    })}>{t("privateBackups.download")}</Button>
    <p className="text-xs text-muted-foreground">{t("privateBackups.manualHint")}</p>
    {folders ? <div className="max-w-xl space-y-2">
      <p className="text-xs text-muted-foreground">{t("privateBackups.schedule")}</p>
      {settings?.folderName && <p className="text-sm">{t("automaticBackups.folder", { name: settings.folderName })}</p>}
      {settings?.lastBackupAt && <p className="text-xs text-muted-foreground">{t("automaticBackups.last", { date: new Date(settings.lastBackupAt).toLocaleString() })}</p>}
      <Label htmlFor="private-backup-interval">{t("automaticBackups.interval")}</Label>
      <select id="private-backup-interval" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={intervalDays} disabled={pending} onChange={(event) => setIntervalDays(Number(event.target.value) === 1 ? 1 : 7)}>
        <option value={7}>{t("automaticBackups.weekly")}</option><option value={1}>{t("automaticBackups.daily")}</option>
      </select>
      <Button variant="outline" disabled={disabled} onClick={() => {
        let chosen: ReturnType<typeof chooseRecoveryBackupFolder>;
        try { chosen = chooseRecoveryBackupFolder(); } catch { setFailed(true); return; }
        void run(async () => {
          const folder = await chosen, next = active();
          const value = await next.configure({ folder, recoveryKey: secret, identity: account.data?.identity, intervalDays });
          if (!alive.current) return; setSettings(value); notePrivateBackupRun(userId, workspaceId, "idle"); window.dispatchEvent(new Event(PRIVATE_RECOVERY_CHANGED));
        });
      }}>{t("automaticBackups.choose")}</Button>
      {settings?.folderName && <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending} onClick={() => void run(async () => {
          const result = await active().run(true); if (!alive.current) return;
          if (result.status === "saved" || result.status === "current") { setSettings(result.settings); notePrivateBackupRun(userId, workspaceId, "saved"); }
          else if (result.status === "folder-unavailable") notePrivateBackupRun(userId, workspaceId, "folder-unavailable");
        })}>{t("automaticBackups.now")}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => void run(async () => {
          const next = active(); await next.disable(); const value = await next.read(); if (!alive.current) return; setSettings(value); notePrivateBackupRun(userId, workspaceId, "idle"); window.dispatchEvent(new Event(PRIVATE_RECOVERY_CHANGED));
        })}>{t("automaticBackups.disable")}</Button>
      </div>}
    </div> : <p className="text-xs text-muted-foreground">{t("automaticBackups.unavailable")}</p>}
    {status === "folder-unavailable" && <p role="status" className="text-sm">{t("automaticBackups.permission")}</p>}
    {(failed || status === "failed") && <p role="alert" className="text-sm text-destructive">{t("privateBackups.failed")}</p>}
  </section>;
}
