"use client";
import * as React from "react";
import { RecoveryBackupPausedError } from "@starter/core";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { privateDataOrigin, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { readCombinedBackupSource } from "@/lib/combined-backup-source";
import { recoveryBackupController, type RecoveryBackupSettings } from "@/lib/recovery-backup-controller";
import { chooseRecoveryBackupFolder, supportsRecoveryBackupFolders } from "@/lib/recovery-backup-folder";
import { useServerSupports } from "@/lib/server-level";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RECOVERY_BACKUP_CHANGED, noteRecoveryBackupRun, recoveryBackupRunState, subscribeRecoveryBackupRun } from "./recovery-backup-driver";
const subscribeNothing = () => () => {};
export function AutomaticRecoveryBackup(): React.JSX.Element | null {
  const { user } = useAuth(), { workspace } = useActiveWorkspace();
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  return user && workspace?.role === "owner" ? <BackupForWorkspace key={`${privateDataOrigin()}:${user.id}:${workspace.id}:${version}`} userId={user.id} workspaceId={workspace.id} /> : null;
}
function BackupForWorkspace({ userId, workspaceId }: { userId: string; workspaceId: string }): React.JSX.Element {
  const t = useT("settings"), utils = trpc.useUtils(), supported = useServerSupports("privacy.combinedRecovery");
  const available = React.useSyncExternalStore(subscribeNothing, supportsRecoveryBackupFolders, () => false), unlocked = !!privateSession(userId);
  const status = React.useSyncExternalStore(subscribeRecoveryBackupRun, () => recoveryBackupRunState(userId, workspaceId), () => "idle" as const);
  const account = trpc.privacy.identity.useQuery({ userId }, { enabled: supported && available && unlocked, retry: false });
  const [secret, setSecret] = React.useState(""), [intervalDays, setIntervalDays] = React.useState<1 | 7>(7), [settings, setSettings] = React.useState<RecoveryBackupSettings | null>(null);
  const [ready, setReady] = React.useState(false);
  const [pending, setPending] = React.useState(false), [failed, setFailed] = React.useState(false);
  const controller = React.useRef<Awaited<ReturnType<typeof recoveryBackupController>> | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    let cancelled = false; alive.current = true;
    if (unlocked && supported && available) void recoveryBackupController(userId, workspaceId).then(async (next) => {
      if (cancelled) { next.close(); return; }
      controller.current = next;
      try { const value = await next.read(); if (!cancelled) { setSettings(value); if (value) setIntervalDays(value.intervalDays); setReady(true); } } catch { if (!cancelled) setFailed(true); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    const unsubscribe = subscribeRecoveryBackupRun(() => { if (controller.current) void controller.current.read().then((value) => { if (!cancelled) setSettings(value); }).catch(() => {}); });
    return () => { cancelled = true; alive.current = false; unsubscribe(); controller.current?.close(); controller.current = null; };
  }, [userId, workspaceId, unlocked, supported, available]);
  const run = async (task: () => Promise<void>) => {
    setPending(true); setFailed(false);
    try { await task(); } catch (error) { if (alive.current) { if (error instanceof RecoveryBackupPausedError) noteRecoveryBackupRun(userId, workspaceId, "folder-unavailable"); else { setFailed(true); noteRecoveryBackupRun(userId, workspaceId, "failed"); } } }
    finally { if (alive.current) { setPending(false); setSecret(""); } }
  };
  return <section className="space-y-3 border-t pt-4" data-testid="automatic-recovery-backup">
    <h3 className="text-sm font-medium">{t("automaticBackups.title")}</h3>
    <p className="max-w-prose text-sm text-muted-foreground">{t("automaticBackups.description")}</p>
    <p className="max-w-prose text-xs text-muted-foreground">{t("automaticBackups.limits")}</p>
    {!supported && <p className="text-sm text-muted-foreground">{t("automaticBackups.unsupported")}</p>}
    {!available ? <p className="text-sm text-muted-foreground">{t("automaticBackups.unavailable")}</p> : !unlocked ? <p className="text-sm text-muted-foreground">{t("automaticBackups.locked")}</p> : <>
      {settings && <p className="text-sm" data-testid="automatic-backup-folder">{t("automaticBackups.folder", { name: settings.folderName })}</p>}
      {settings?.lastBackupAt && <p className="text-xs text-muted-foreground">{t("automaticBackups.last", { date: new Date(settings.lastBackupAt).toLocaleString() })}</p>}
      <div className="max-w-xl space-y-2">
        {!settings && <>
          <p className="text-xs text-muted-foreground">{t("automaticBackups.keyHint")}</p>
          <Label htmlFor="automatic-backup-key">{t("automaticBackups.recoveryKey")}</Label>
          <Input id="automatic-backup-key" type="password" autoComplete="off" value={secret} disabled={pending} onChange={(event) => setSecret(event.target.value)} />
        </>}
        <Label htmlFor="automatic-backup-interval">{t("automaticBackups.interval")}</Label>
        <select id="automatic-backup-interval" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={intervalDays} disabled={pending} onChange={(event) => setIntervalDays(Number(event.target.value) === 1 ? 1 : 7)}>
          <option value={7}>{t("automaticBackups.weekly")}</option><option value={1}>{t("automaticBackups.daily")}</option>
        </select>
        <Button variant="outline" disabled={pending || !supported || (!settings && (!account.data || secret.trim().length !== 43)) || !ready} data-testid="automatic-backup-choose" onClick={() => {
          // Invoke the chooser synchronously within this explicit user action.
          let chosen: ReturnType<typeof chooseRecoveryBackupFolder>;
          try { chosen = chooseRecoveryBackupFolder(); } catch { setFailed(true); return; }
          void run(async () => {
            const folder = await chosen, active = controller.current;
            if (!active) throw new Error("Private backup settings changed");
            const value = await active.configure({ folder, recoveryKey: secret, identity: account.data?.identity, intervalDays });
            if (!alive.current) return; setSettings(value); noteRecoveryBackupRun(userId, workspaceId, "idle"); window.dispatchEvent(new Event(RECOVERY_BACKUP_CHANGED));
          });
        }}>{t("automaticBackups.choose")}</Button>
      </div>
      {settings && <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending || !supported} data-testid="automatic-backup-now" onClick={() => void run(async () => {
          const active = controller.current; if (!active) throw new Error("Unlock private data first");
          const result = await active.run(() => {
            const signal = AbortSignal.timeout(30000);
            return readCombinedBackupSource(userId, workspaceId, {
              challenge: () => utils.client.privacy.recoveryChallenge.mutate({ workspaceId }, { signal }),
              originals: (proof) => utils.client.privacy.combinedRecovery.mutate({ workspaceId, ...proof }, { signal }),
            }, signal);
          }, true);
          if (!alive.current) return;
          if (result.status === "saved" || result.status === "current") { setSettings(result.settings); noteRecoveryBackupRun(userId, workspaceId, "saved"); }
          else noteRecoveryBackupRun(userId, workspaceId, "folder-unavailable");
        })}>{t("automaticBackups.now")}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => void run(async () => { await controller.current?.disable(); if (alive.current) { setSettings(null); noteRecoveryBackupRun(userId, workspaceId, "idle"); } })}>{t("automaticBackups.disable")}</Button>
      </div>}
    </>}
    {status === "folder-unavailable" && <p role="status" className="text-sm">{t("automaticBackups.permission")}</p>}
    {(failed || status === "failed") && <p role="alert" className="text-sm text-destructive">{t("automaticBackups.failed")}</p>}
  </section>;
}
