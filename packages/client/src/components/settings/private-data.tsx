"use client";
import { cachedPrivateIdentity, rememberPrivateIdentity, samePrivateIdentityKeys } from "@/lib/private-identity-cache";
import type { PrivateIdentity } from "@starter/shared";
import { PrivateKeyCode } from "./private-key-code";
import { PrivateActivity } from "./private-activity";
import { PrivateDeviceUnlock } from "./private-device-unlock";
import { useServerSupports } from "@/lib/server-level";
import * as React from "react";
import { signPrivateChange } from "@starter/core";
import { authClient } from "@/lib/auth-client";
import { downloadBlob } from "@/lib/download";
import { evaluatePrivatePasskey, installPrivateSession, lockPrivateData, newPrivateIdentity, privateSession, privateOperationScope, privateDataOrigin, prfBytes, PRIVATE_PRF_INPUT, subscribePrivateSession, unlockPrivateRecovery, unlockWithSavedPasskey, wrapIdentityWithPrf } from "@/lib/private-session";
import { useIsTokenShell } from "@/hooks/use-shell";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useT } from "@/i18n/use-t";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

type Enrollment = Awaited<ReturnType<typeof newPrivateIdentity>>;
export function PrivateDataCard({ unlockOnly = false }: { unlockOnly?: boolean } = {}): React.JSX.Element | null {
  const { user } = useAuth();
  return user ? <PrivateDataForUser key={`${user.id}:${unlockOnly}`} id={user.id} unlockOnly={unlockOnly} /> : null;
}
function PrivateDataForUser({ id, unlockOnly }: { id: string; unlockOnly: boolean }): React.JSX.Element {
  const t = useT("settings");
  const native = useIsTokenShell();
  const deviceUnlockSupported = useServerSupports("privacy.deviceUnlock");
  const account = trpc.privacy.identity.useQuery({ userId: id }, { retry: false });
  const enroll = trpc.privacy.enroll.useMutation();
  const updateIdentity = trpc.privacy.updateIdentity.useMutation();
  const [draft, setDraft] = React.useState<Enrollment | null>(null);
  const [confirmation, setConfirmation] = React.useState("");
  const [recovery, setRecovery] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [, redraw] = React.useReducer((v: number) => v + 1, 0);
  React.useEffect(() => subscribePrivateSession(redraw), []);
  const server = privateDataOrigin();
  const [local, setLocal] = React.useState<{ scope: string; identity: PrivateIdentity | null; failed: boolean } | null>(null);
  const cacheScope = JSON.stringify([server, id]);
  React.useEffect(() => {
    let active = true;
    void cachedPrivateIdentity(id).then((identity) => { if (active) setLocal({ scope: cacheScope, identity, failed: false }); }).catch(() => { if (active) setLocal({ scope: cacheScope, identity: null, failed: true }); });
    return () => { active = false; };
  }, [cacheScope, id]);
  const cacheReady = local?.scope === cacheScope, cached = cacheReady ? local.identity : null;
  const advertised = account.data?.identity;
  const replaced = !!cached && !!advertised && !samePrivateIdentityKeys(cached, advertised);
  // The durable local wrapper remains usable during an outage or a server key
  // substitution. Never replace it from a query result. Unlock grants no new
  // inventory/directory freshness or server membership.
  const current = privateSession(id), identity = cached ?? (cacheReady && !local.failed ? advertised : null);
  const cacheFailed = cacheReady && local.failed;
  const remember = async (next: PrivateIdentity, recoveryKey?: string) => {
    const saved = await rememberPrivateIdentity(id, next, recoveryKey);
    setLocal({ scope: cacheScope, identity: saved, failed: false });
  };
  const run = async (task: () => Promise<void>) => {
    setPending(true); setProblem(null);
    try { await task(); } catch { setProblem(t("privateData.failed")); } finally { setPending(false); }
  };
  return <Card data-testid="private-data-settings">
    <CardHeader><CardTitle>{t("privateData.title")}</CardTitle>{!unlockOnly && <CardDescription>{t("privateData.description")}</CardDescription>}</CardHeader>
    <CardContent className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t("privateData.recoveryExplanation")}</p>
      {native && <p className="max-w-prose text-sm text-muted-foreground">{t(deviceUnlockSupported ? "privateData.nativeBrowserUnlock" : "privateData.nativePasskeys")}</p>}
      {unlockOnly && !identity && !account.isLoading && cacheReady && <p role="status" className="text-sm">{t("privateData.keysUnavailable")}</p>}
      {!unlockOnly && !current && !identity && !draft && cacheReady && !cacheFailed && <Button variant="outline" disabled={pending || account.isLoading || account.isError} onClick={() => void run(async () => setDraft(await newPrivateIdentity(id)))}>{t("privateData.prepare")}</Button>}
      {!unlockOnly && draft && <div className="max-w-xl space-y-3">
        <p className="text-sm">{t("privateData.saveRecovery")}</p>
        <code className="block break-all rounded-md bg-muted p-3 text-sm select-all">{draft.recoveryKey}</code>
        <Button variant="outline" onClick={() => downloadBlob("trackyourtime-recovery-key.json", new Blob([JSON.stringify({ format: "trackyourtime-recovery-key-v1", userId: id, server: privateDataOrigin(), recoveryKey: draft.recoveryKey }, null, 2)], { type: "application/json" }))}>{t("privateData.downloadRecovery")}</Button>
        <Label htmlFor="private-confirm">{t("privateData.confirmRecovery")}</Label>
        <Input id="private-confirm" value={confirmation} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />
        <Button disabled={pending || confirmation.trim() !== draft.recoveryKey.slice(-8)} onClick={() => void run(async () => {
          draft.assertCurrent(); await enroll.mutateAsync({ identity: draft.identity, userId: id, server: privateDataOrigin() }); draft.assertCurrent(); installPrivateSession(id, draft.secrets); await remember(draft.identity, draft.recoveryKey); setDraft(null); setConfirmation(""); await account.refetch();
        })}>{t("privateData.finishSetup")}</Button>
      </div>}
      {identity && !current && <div className="grid max-w-xl justify-items-start gap-3">
        {native && deviceUnlockSupported && <PrivateDeviceUnlock userId={id} />}
        {!native && <Button variant="outline" disabled={pending || identity.passkeys.length === 0} onClick={() => void run(async () => { await unlockWithSavedPasskey(id, identity); await remember(identity); })}>{t("privateData.unlockPasskey")}</Button>}
        <Label htmlFor="private-recovery">{t("privateData.recoveryKey")}</Label>
        <Input id="private-recovery" type="password" autoComplete="off" value={recovery} onChange={(event) => setRecovery(event.target.value)} />
        <Button variant="outline" disabled={pending || recovery.trim().length !== 43} onClick={() => void run(async () => { await unlockPrivateRecovery(id, identity, recovery); setRecovery(""); await remember(identity, recovery); })}>{t("privateData.unlockRecovery")}</Button>
      </div>}
      {identity && current && <div className="space-y-3">
        <p role="status" className="text-sm">{t("privateData.unlocked")}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={native || pending || !advertised || replaced || account.isError} onClick={() => void run(async () => {
          const assertCurrent = privateOperationScope(id);
          const listed = await authClient.passkey.listUserPasskeys();
          if (listed.error) throw new Error("Could not load passkeys");
          const available = (listed.data ?? []).filter((p) => !advertised!.passkeys.some((saved) => saved.credentialId === p.credentialID));
          let credentialId: string, secret: Uint8Array<ArrayBuffer> | null;
          if (available.length) {
            try { ({ credentialId, secret } = await evaluatePrivatePasskey(available.map((p) => p.credentialID))); }
            catch { setProblem(t("privateData.passkeyNoEncryption")); return; }
          } else {
            const result = await authClient.passkey.addPasskey({ name: t("privateData.passkeyName"), extensions: { prf: { eval: { first: PRIVATE_PRF_INPUT } } }, returnWebAuthnResponse: true } as unknown as Parameters<typeof authClient.passkey.addPasskey>[0]);
            if (result.error || !("webauthn" in result)) throw new Error("Passkey registration failed");
            credentialId = result.webauthn.response.id;
            secret = prfBytes((result.webauthn.clientExtensionResults as { prf?: { results?: { first?: unknown } } }).prf?.results?.first);
            if (!secret) {
              try { ({ secret } = await evaluatePrivatePasskey([credentialId])); }
              catch { setProblem(t("privateData.passkeyNoEncryption")); return; }
            }
          }
          try {
            const next = { ...advertised!, recovery: identity.recovery, passkeys: [...advertised!.passkeys, { credentialId, envelope: await wrapIdentityWithPrf(id, secret, identity) }] };
            const revision = account.data!.revision;
            const signature = await signPrivateChange(current.signingPrivateKey, { userId: id, revision, identity: next });
            assertCurrent(); if (privateSession(id) !== current) throw new Error("Private data is locked");
            await updateIdentity.mutateAsync({ identity: next, revision, signature }); await remember(next); await account.refetch();
          } finally { secret.fill(0); }
        })}>{t("privateData.addPasskey")}</Button><Button variant="outline" onClick={lockPrivateData}>{t("privateData.lock")}</Button></div>
      </div>}
      {!unlockOnly && <PrivateActivity userId={id} />}
      {!unlockOnly && identity && <PrivateKeyCode userId={id} />}
      {(cacheFailed || replaced || (!!cached && account.isError)) && <p role="status" className="text-sm">{t(cacheFailed ? "privateData.savedKeysFailed" : replaced ? "privateData.savedKeysChanged" : "privateData.savedKeysOffline")}</p>}
      {(problem || (account.isError && !cached)) && <p role="alert" className="text-sm text-destructive">{problem ?? t("privateData.failed")}</p>}
    </CardContent>
  </Card>;
}
