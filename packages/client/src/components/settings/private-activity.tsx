"use client";
import * as React from "react";
import { useT } from "@/i18n/use-t";
import { desktopActivity } from "@/lib/desktop-activity";
import { privateSession, protectPrivateActivity } from "@/lib/private-session";
import { Button } from "@/components/ui/button";
import type { DesktopActivitySnapshot } from "@starter/shared";

export function PrivateActivity({ userId }: { userId: string }): React.JSX.Element | null {
  const t = useT("settings");
  const [snapshot, setSnapshot] = React.useState<DesktopActivitySnapshot | null>(null);
  const [remember, setRemember] = React.useState(false);
  const [pending, setPending] = React.useState(false), [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    const activity = desktopActivity(); if (!activity?.protect) return;
    let live = true;
    void activity.snapshot().then((value) => { if (live) { setSnapshot(value); setRemember(value.protection?.trusted ?? false); } }).catch(() => undefined);
    const off = activity.onChanged((value) => { if (live) setSnapshot(value); });
    return () => { live = false; off(); };
  }, []);
  if (!snapshot?.protection) return null;
  return <section className="space-y-3 border-t pt-4" data-testid="private-activity">
    <h3 className="text-sm font-medium">{t("privateActivity.title")}</h3>
    <p className="max-w-prose text-sm text-muted-foreground">{t("privateActivity.description")}</p>
    <p className="text-sm" role="status">{t(snapshot.protection.encrypted ? snapshot.protection.locked ? "privateActivity.locked" : "privateActivity.encrypted" : "privateActivity.standard")}</p>
    {snapshot.protection.canTrust && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{t("privateActivity.remember")}</label>}
    {snapshot.protection.trusted && <p className="text-xs text-muted-foreground">{t("privateActivity.trusted")}</p>}
    {(!snapshot.protection.encrypted || snapshot.protection.locked) && <Button variant="outline" disabled={pending || !privateSession(userId)} onClick={() => {
      setPending(true); setFailed(false);
      void protectPrivateActivity(userId, remember).then(async () => {
        const value = await desktopActivity()?.snapshot(); if (value) setSnapshot(value);
      }).catch(() => setFailed(true)).finally(() => setPending(false));
    }}>{t(snapshot.protection.encrypted ? "privateActivity.unlock" : "privateActivity.protect")}</Button>}
    {snapshot.protection.encrypted && !snapshot.protection.locked && <Button variant="outline" disabled={pending || !privateSession(userId)} onClick={() => {
      setPending(true); setFailed(false);
      void protectPrivateActivity(userId, remember).then(async () => { const value = await desktopActivity()?.snapshot(); if (value) setSnapshot(value); }).catch(() => setFailed(true)).finally(() => setPending(false));
    }}>{t("privateActivity.saveTrust")}</Button>}
    {!privateSession(userId) && <p className="text-xs text-muted-foreground">{t("privateActivity.needsKeys")}</p>}
    {failed && <p className="text-sm text-destructive" role="alert">{t("privateActivity.failed")}</p>}
  </section>;
}
