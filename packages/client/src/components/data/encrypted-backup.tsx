"use client";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useAuth } from "@/hooks/use-auth";
import { privateDataOrigin } from "@/lib/private-session";
import * as React from "react";
import { decryptBackup, encryptBackup, type PasswordCiphertext } from "@starter/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { downloadBlob } from "@/lib/download";
import { trpc } from "@/lib/trpc";
import { useT } from "@/i18n/use-t";

/** Encryption and password checks happen before any download. Recovery stays local. */
export function EncryptedBackup(): React.JSX.Element {
  const t = useT("settings");
  const { user } = useAuth(), { workspace } = useActiveWorkspace();
  const preferenceKey = user && workspace ? `trackyourtime:encrypted-backup:${privateDataOrigin()}:${user.id}:${workspace.id}` : null;
  const currentScope = React.useRef(preferenceKey);
  React.useLayoutEffect(() => { currentScope.current = preferenceKey; return () => { currentScope.current = null; }; }, [preferenceKey]);
  const [checkedAt] = React.useState(Date.now);
  const savePreference = (suffix: string, value: string) => { try { if (preferenceKey) localStorage.setItem(`${preferenceKey}:${suffix}`, value); } catch { /* Downloads still work without browser preferences. */ } };
  const exportJson = trpc.data.exportJson.useMutation();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [restored, setRestored] = React.useState<string | null>(null);
  const [lastBackup, setLastBackup] = React.useState<string | null>(null);
  const [remindDays, setRemindDays] = React.useState(0);
  // A backup of A must never make B's reminder look up to date.
  React.useEffect(() => {
    let stamp: string | null = null, days = 0;
    try {
      if (preferenceKey) {
        stamp = localStorage.getItem(`${preferenceKey}:last`);
        days = Number(localStorage.getItem(`${preferenceKey}:reminder`));
      }
    } catch { /* Preferences are optional. */ }
    // Device preferences are read after hydration; static HTML has none.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastBackup(stamp && Number.isFinite(Date.parse(stamp)) ? stamp : null);
    setRemindDays(days === 7 || days === 30 ? days : 0);
    setPassword(""); setConfirm(""); setRestored(null);
  }, [preferenceKey]);
  const due = remindDays > 0 && (!lastBackup || checkedAt - Date.parse(lastBackup) > remindDays * 86400000);
  const run = async (task: () => Promise<void>) => {
    setError(false); setPending(true);
    try { await task(); } catch { setError(true); } finally { setPending(false); }
  };
  return <section className="space-y-3 border-t pt-4" data-testid="encrypted-backup">
    <h3 className="text-sm font-medium">{t("backups.title")}</h3>
    <p className="max-w-prose text-sm text-muted-foreground">{t("backups.description")}</p>
    <div className="grid max-w-xl gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="backup-password">{t("backups.password")}</Label><PasswordInput id="backup-password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="backup-confirm">{t("backups.confirm")}</Label><PasswordInput id="backup-confirm" value={confirm} autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} /></div>
    </div>
    <Button variant="outline" disabled={pending || !workspace || password.length < 12 || password !== confirm} data-testid="encrypted-backup-download" onClick={() => void run(async () => {
      const scope = preferenceKey;
      const data = await exportJson.mutateAsync({ workspaceId: workspace!.id });
      if (currentScope.current !== scope) return;
      const encrypted = await encryptBackup(data, password);
      // Verify the complete round trip before calling this a usable backup.
      const check = await decryptBackup(encrypted, password);
      if (JSON.stringify(check) !== JSON.stringify(data)) throw new Error("Backup verification failed");
      if (currentScope.current !== scope) return;
      downloadBlob(`trackyourtime-backup-${new Date().toISOString().slice(0, 10)}.tytbackup`, new Blob([JSON.stringify(encrypted)], { type: "application/json" }));
      const stamp = new Date().toISOString(); setLastBackup(stamp);
      savePreference("last", stamp);
      setPassword(""); setConfirm("");
    })}>{pending ? t("backups.working") : t("backups.download")}</Button>
    <p className="max-w-prose text-xs text-muted-foreground">{t("backups.exportLimits")}</p>
    <div className="max-w-xs space-y-1"><Label htmlFor="backup-reminder">{t("backups.remind")}</Label><select id="backup-reminder" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={remindDays} onChange={(event) => {
      const value = Number(event.target.value); setRemindDays(value); savePreference("reminder", String(value));
    }}><option value={0}>{t("backups.never")}</option><option value={7}>{t("backups.weekly")}</option><option value={30}>{t("backups.monthly")}</option></select></div>
    {due && <p role="status" className="text-sm">{t("backups.due")}</p>}
    {lastBackup && <p className="text-xs text-muted-foreground">{t("backups.last", { date: new Date(lastBackup).toLocaleDateString() })}</p>}
    <div className="max-w-xl space-y-2 border-t pt-3">
      <Label htmlFor="backup-restore">{t("backups.open")}</Label>
      <p className="text-xs text-muted-foreground">{t("backups.openHint")}</p>
      <Input id="backup-restore" type="file" accept=".tytbackup,application/json" disabled={pending || password.length < 12} onChange={(event) => {
        const file = event.target.files?.[0]; if (!file) return;
        void run(async () => {
          if (file.size > 32 * 1024 * 1024) throw new Error("Backup too large");
          const scope = preferenceKey;
          const box = JSON.parse(await file.text()) as PasswordCiphertext;
          const value = await decryptBackup<unknown>(box, password);
          // This action saves plaintext only at the person's explicit request.
          // It does not send the password or the encrypted file to the server.
          if (currentScope.current !== scope) return;
          setRestored(JSON.stringify(value, null, 2));
          setPassword(""); setConfirm("");
        });
        event.target.value = "";
      }} />
      {restored !== null && <Button variant="outline" onClick={() => {
        downloadBlob("trackyourtime-restored-export.json", new Blob([restored], { type: "application/json" })); setRestored(null);
      }}>{t("backups.saveRestored")}</Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{t("backups.failed")}</p>}
  </section>;
}
