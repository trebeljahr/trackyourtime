"use client";
import * as React from "react";
import Link from "next/link";
import { privateDeviceInviteFromHash, type PrivateDeviceInvite } from "@starter/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PrivateDataCard } from "@/components/settings/private-data";
import { useAuth } from "@/hooks/use-auth";
import { useT } from "@/i18n/use-t";
import { signOut } from "@/lib/auth-client";
import { sealPrivateDeviceUnlock } from "@/lib/private-device";
import { privateDataOrigin, privateSession, subscribePrivateSession } from "@/lib/private-session";
import { authPageHref } from "@/lib/safe-next";
import { refreshServerLevel, useServerSupports } from "@/lib/server-level";
import { trpc } from "@/lib/trpc";
type Approval = Awaited<ReturnType<typeof sealPrivateDeviceUnlock>>;
export function PrivateDeviceApproval(): React.JSX.Element {
  const t = useT("settings"), { user, isLoading } = useAuth();
  const supported = useServerSupports("privacy.deviceUnlock");
  const [invite, setInvite] = React.useState<PrivateDeviceInvite | null>(null);
  const [invalid, setInvalid] = React.useState(false), [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false);
  const [approval, setApproval] = React.useState<Approval | null>(null);
  const [sent, setSent] = React.useState(false);
  const [returnPath, setReturnPath] = React.useState("/private-device/");
  const [, redraw] = React.useReducer((value: number) => value + 1, 0);
  const pollStatus = trpc.privacy.deviceUnlockStatus.useMutation().mutateAsync;
  const approve = trpc.privacy.approveDeviceUnlock.useMutation().mutateAsync;
  const live = React.useRef(false);
  const currentInvite = React.useRef(invite);
  React.useLayoutEffect(() => { currentInvite.current = invite; }, [invite]);
  React.useEffect(() => { live.current = true; void refreshServerLevel(); return () => { live.current = false; }; }, []);
  React.useEffect(() => subscribePrivateSession(redraw), []);
  React.useEffect(() => {
    const read = () => {
      try {
        const found = privateDeviceInviteFromHash(window.location.hash);
        if (found.server !== privateDataOrigin() || found.expiresAt <= Date.now()) throw new Error("Invalid private-device request");
        setInvite(found); setReturnPath(`/private-device/${window.location.hash}`);
        setInvalid(false); setReady(false); setSent(false); setApproval(null); setFailed(false); setBusy(false);
      } catch { setInvalid(true); }
    };
    // The fragment contains only a public receiving key and request metadata.
    // Reading it after hydration keeps the static page deterministic.
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  React.useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(() => setInvalid(true), Math.max(0, invite.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [invite]);
  const matches = !!user && invite?.userId === user.id;
  const identity = trpc.privacy.identity.useQuery({ userId: user?.id ?? "pending" }, { enabled: supported && matches, retry: false });
  React.useEffect(() => {
    if (!invite || !matches || !supported) return;
    let active = true;
    void pollStatus({ requestId: invite.requestId }).then((value) => {
      if (!active) return;
      if (value.box) setInvalid(true); else setReady(true);
    }, () => { if (active) setInvalid(true); });
    return () => { active = false; };
  }, [invite, matches, supported, pollStatus]);
  const unlocked = user ? privateSession(user.id) : null;
  const login = authPageHref("login", { next: returnPath });
  const send = async () => {
    if (!invite || !user || !identity.data || !matches) return;
    setBusy(true); setFailed(false);
    try {
      const result = approval ?? await sealPrivateDeviceUnlock(user.id, invite, identity.data.identity);
      if (!live.current || currentInvite.current !== invite) return;
      // Preserve the same code/ciphertext if the relay's reply is lost.
      setApproval(result);
      await approve({ requestId: invite.requestId, box: result.approval });
      if (live.current && currentInvite.current === invite) setSent(true);
    } catch { if (live.current && currentInvite.current === invite) setFailed(true); }
    finally { if (live.current && currentInvite.current === invite) setBusy(false); }
  };
  return <main className="mx-auto w-full max-w-2xl space-y-5 px-5 py-12" data-testid="private-device-approval">
    <Card><CardHeader><CardTitle>{t("privateDevice.approvalTitle")}</CardTitle><CardDescription>{t("privateDevice.approvalDescription")}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {invalid && <p role="alert" className="text-sm text-destructive">{t("privateDevice.invalid")}</p>}
        {!invalid && !isLoading && !user && <Button asChild variant="outline"><Link href={login}>{t("privateDevice.signIn")}</Link></Button>}
        {!invalid && user && !matches && <div className="space-y-3"><p className="text-sm">{t("privateDevice.wrongAccount", { email: user.email })}</p><Button variant="outline" onClick={() => void signOut().then(() => { window.location.assign(login); })}>{t("privateDevice.switchAccount")}</Button></div>}
        {!invalid && matches && <>
          <p className="text-sm">{t("privateDevice.account", { email: user!.email })}</p>
          {approval && <div className="space-y-2"><p className="text-sm">{t("privateDevice.codeHint")}</p><code className="block select-all rounded-md bg-muted px-4 py-3 text-2xl tracking-widest" data-testid="private-device-approval-code">{approval.code.slice(0, 4)} {approval.code.slice(4)}</code></div>}
          {sent ? <p role="status" className="text-sm">{t("privateDevice.sent")}</p> : <Button variant="outline" disabled={!supported || !ready || !unlocked || !identity.data || busy} onClick={() => void send()}>{busy ? t("privateDevice.sending") : approval ? t("privateDevice.retry") : t("privateDevice.approve")}</Button>}
        </>}
        {failed && <p role="alert" className="text-sm text-destructive">{t("privateDevice.failed")}</p>}
      </CardContent>
    </Card>
    {!invalid && matches && supported && !unlocked && <PrivateDataCard />}
  </main>;
}
