"use client";
import * as React from "react";
import { KeyRound } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { downloadBlob } from "@/lib/download";
import { rememberPrivateIdentity } from "@/lib/private-identity-cache";
import { privateDataOrigin, privateSession, subscribePrivateSession, unlockPrivateRecovery } from "@/lib/private-session";
import {
  checkPasswordKeysStale, passwordKeysNeedRecovery, passwordKeysStale, recoveryKeySaved, recoveryKeyToSave,
  repairKeysWithPassword, subscribePasswordUnlockNotices, WrongPasswordError,
} from "@/lib/password-unlock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

const subscribeNothing = (): (() => void) => () => undefined;

/** Re-render on any change to the keys' notices or to this device's unlocked keys. */
function useKeysNoticeState(): void {
  const [, redraw] = React.useReducer((v: number) => v + 1, 0);
  React.useEffect(() => subscribePasswordUnlockNotices(redraw), []);
  React.useEffect(() => subscribePrivateSession(redraw), []);
}

/**
 * What the person must know about their account keys, inline above the page:
 * save a new recovery key, open keys a password reset left closed, or seal the
 * keys under a password reset elsewhere. Each can be put off until the next
 * page load ("Later"); nothing here is stored.
 */
export function PrivateKeysNotice(): React.JSX.Element | null {
  const { user } = useAuth();
  const id = user?.id ?? null;
  useKeysNoticeState();
  // False in the prerendered HTML and during hydration, true afterwards.
  const mounted = React.useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [later, setLater] = React.useState<ReadonlySet<string>>(new Set());
  const unlocked = !!id && !!privateSession(id);
  React.useEffect(() => { if (id && unlocked) void checkPasswordKeysStale(id); }, [id, unlocked]);
  if (!mounted || !id) return null;
  const putOff = (kind: string) => setLater((previous) => new Set(previous).add(kind));
  const recoveryKey = recoveryKeyToSave(id);
  if (recoveryKey && !later.has("save")) return <NoticeFrame><SaveRecoveryKey userId={id} recoveryKey={recoveryKey} onLater={() => putOff("save")} /></NoticeFrame>;
  if (passwordKeysNeedRecovery(id) && !later.has("recover")) return <NoticeFrame><RecoverKeys userId={id} onLater={() => putOff("recover")} /></NoticeFrame>;
  if (passwordKeysStale(id) && !later.has("stale")) return <NoticeFrame><UpdateKeysAfterReset userId={id} onLater={() => putOff("stale")} /></NoticeFrame>;
  return null;
}

function NoticeFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <section className="mb-4 flex max-w-3xl gap-3 rounded-lg border bg-card p-4 text-card-foreground" data-testid="private-keys-notice">
    <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
    <div className="min-w-0 flex-1 space-y-3">{children}</div>
  </section>;
}

/** Shown once per new recovery key, here and in Settings → Private data. */
export function SaveRecoveryKey({ userId, recoveryKey, onLater }: { userId: string; recoveryKey: string; onLater?: () => void }): React.JSX.Element {
  const t = useT("shell");
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(recoveryKey); setCopied(true); } catch { /* The key stays selectable. */ }
  };
  const download = () => downloadBlob("trackyourtime-recovery-key.json", new Blob([JSON.stringify({ format: "trackyourtime-recovery-key-v1", userId, server: privateDataOrigin(), recoveryKey }, null, 2)], { type: "application/json" }));
  return <div className="space-y-3" data-testid="save-recovery-key">
    <h2 className="font-semibold">{t("keysNotice.saveTitle")}</h2>
    <p className="max-w-prose text-sm text-muted-foreground">{t("keysNotice.saveDetail")}</p>
    <code className="block break-all rounded-md bg-muted p-3 text-sm select-all" data-testid="recovery-key-value">{recoveryKey}</code>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => void copy()}>{copied ? t("keysNotice.copied") : t("keysNotice.copy")}</Button>
      <Button variant="outline" onClick={download}>{t("keysNotice.download")}</Button>
      <Button onClick={recoveryKeySaved} data-testid="recovery-key-saved">{t("keysNotice.saved")}</Button>
      {onLater && <Button variant="ghost" onClick={onLater}>{t("keysNotice.later")}</Button>}
    </div>
  </div>;
}

function RecoverKeys({ userId, onLater }: { userId: string; onLater: () => void }): React.JSX.Element {
  const t = useT("shell");
  const account = trpc.privacy.identity.useQuery({ userId }, { retry: false });
  const [value, setValue] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const identity = account.data?.identity;
    if (!identity) return;
    setPending(true); setProblem(null);
    try {
      await unlockPrivateRecovery(userId, identity, value);
      setValue("");
      await rememberPrivateIdentity(userId, identity, value.trim()).catch(() => undefined);
    } catch { setProblem(t("keysNotice.wrongRecovery")); }
    finally { setPending(false); }
  };
  return <form className="space-y-3" onSubmit={(event) => void submit(event)} data-testid="recover-keys">
    <h2 className="font-semibold">{t("keysNotice.recoverTitle")}</h2>
    <p className="max-w-prose text-sm text-muted-foreground">{t("keysNotice.recoverDetail")}</p>
    <p className="max-w-prose text-sm text-muted-foreground">{t("keysNotice.recoverNeither")}</p>
    <div className="max-w-md space-y-2">
      <Label htmlFor="keys-notice-recovery">{t("keysNotice.recoveryKey")}</Label>
      <Input id="keys-notice-recovery" type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} data-testid="recover-keys-input" />
    </div>
    {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={pending || !account.data || value.trim().length !== 43}>{t("keysNotice.unlock")}</Button>
      <Button type="button" variant="ghost" onClick={onLater}>{t("keysNotice.later")}</Button>
    </div>
  </form>;
}

function UpdateKeysAfterReset({ userId, onLater }: { userId: string; onLater: () => void }): React.JSX.Element {
  const t = useT("shell");
  const [value, setValue] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true); setProblem(null);
    try { await repairKeysWithPassword(userId, value); setValue(""); }
    catch (error) { setProblem(t(error instanceof WrongPasswordError ? "keysNotice.wrongPassword" : "keysNotice.failed")); }
    finally { setPending(false); }
  };
  return <form className="space-y-3" onSubmit={(event) => void submit(event)} data-testid="update-keys-after-reset">
    <h2 className="font-semibold">{t("keysNotice.staleTitle")}</h2>
    <p className="max-w-prose text-sm text-muted-foreground">{t("keysNotice.staleDetail")}</p>
    <div className="max-w-md space-y-2">
      <Label htmlFor="keys-notice-password">{t("keysNotice.password")}</Label>
      <PasswordInput id="keys-notice-password" autoComplete="current-password" value={value} onChange={(event) => setValue(event.target.value)} data-testid="update-keys-password" />
    </div>
    {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={pending || !value}>{t("keysNotice.update")}</Button>
      <Button type="button" variant="ghost" onClick={onLater}>{t("keysNotice.later")}</Button>
    </div>
  </form>;
}
