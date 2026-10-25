"use client";
import * as React from "react";
import { decryptBackup, decryptCombinedRecoveryKeyBackup, decryptRecoveryKeyBackup, verifyCombinedWorkspaceRecoveryArchive, verifyWorkspaceRecoveryArchive, type PasswordCiphertext } from "@starter/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/use-t";
import { downloadBlob } from "@/lib/download";
/** Entirely local. Account access, server availability and unlocked app keys
 * are unnecessary when the person has their saved recovery secret and file. */
export function OpenRecoveryBackup({ standalone = false }: { standalone?: boolean } = {}): React.JSX.Element {
  const t = useT("settings");
  const [file, setFile] = React.useState<File | null>(null), [secret, setSecret] = React.useState("");
  const [pending, setPending] = React.useState(false), [failed, setFailed] = React.useState(false), [opened, setOpened] = React.useState<{ json: string; recovery: boolean; combined: boolean } | null>(null);
  const generation = React.useRef(0);
  React.useEffect(() => () => { generation.current++; }, []);
  const open = async () => {
    if (!file || secret.length < 12 || pending) return;
    const at = generation.current;
    setPending(true); setFailed(false); setOpened(null);
    try {
      if (file.size > 36 * 1024 * 1024) throw new Error("Backup exceeds its file limit");
      const parsed = JSON.parse(await file.text());
      const value = parsed?.header?.format === "trackyourtime-recovery-key-backup-v2"
        ? await decryptCombinedRecoveryKeyBackup(parsed, secret)
        : parsed?.header?.format === "trackyourtime-recovery-key-backup-v1"
        ? await decryptRecoveryKeyBackup(parsed, secret)
        : await decryptBackup<unknown>(parsed as PasswordCiphertext, secret);
      const combined = value !== null && typeof value === "object" && "format" in value && value.format === "trackyourtime-workspace-recovery-v2";
      const legacyRecovery = value !== null && typeof value === "object" && "format" in value && value.format === "trackyourtime-workspace-recovery-v1";
      if (combined) await verifyCombinedWorkspaceRecoveryArchive(value);
      else if (legacyRecovery) await verifyWorkspaceRecoveryArchive(value);
      const recovery = combined || legacyRecovery;
      if (at === generation.current) setOpened({ json: JSON.stringify(value, null, 2), recovery, combined });
    } catch { if (at === generation.current) setFailed(true); }
    finally { if (at === generation.current) { setSecret(""); setPending(false); } }
  };
  return <section className={standalone ? "space-y-4" : "space-y-3 border-t pt-4"} data-testid="open-recovery-backup">
    {standalone ? <h1 className="text-2xl font-semibold">{t("automaticBackups.openTitle")}</h1> : <h3 className="text-sm font-medium">{t("automaticBackups.openTitle")}</h3>}
    <p className="max-w-prose text-sm text-muted-foreground">{t("automaticBackups.openDetail")}</p>
    <div className="max-w-xl space-y-2">
      <Label htmlFor="recovery-backup-file">{t("automaticBackups.file")}</Label>
      <Input id="recovery-backup-file" type="file" accept=".tytrecovery,.tytbackup,application/json" disabled={pending} onChange={(event) => { generation.current++; setOpened(null); setFailed(false); setFile(event.target.files?.[0] ?? null); }} />
      <Label htmlFor="recovery-backup-secret">{t("automaticBackups.openSecret")}</Label>
      <Input id="recovery-backup-secret" type="password" autoComplete="off" value={secret} disabled={pending} onChange={(event) => setSecret(event.target.value)} />
      <Button variant="outline" disabled={!file || secret.length < 12 || pending} onClick={() => void open()}>{t(pending ? "automaticBackups.working" : "automaticBackups.open")}</Button>
    </div>
    {failed && <p role="alert" className="text-sm text-destructive">{t("automaticBackups.openFailed")}</p>}
    {opened !== null && <div className="space-y-2">
      <p role="status" className="text-sm">{t(opened.combined ? "automaticBackups.openedCombined" : opened.recovery ? "automaticBackups.opened" : "automaticBackups.openedPortable")}</p>
      <Button variant="outline" onClick={() => { downloadBlob(opened.combined ? "trackyourtime-combined-recovery.json" : opened.recovery ? "trackyourtime-workspace-recovery.json" : "trackyourtime-restored-export.json", new Blob([opened.json], { type: "application/json" })); setOpened(null); }}>{t(opened.recovery ? "backups.saveRecoveryJson" : "backups.saveRestored")}</Button>
    </div>}
  </section>;
}
