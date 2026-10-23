"use client";
import { PrivateActivity } from "./private-activity";
import * as React from "react";
import { fingerprint, signPrivateChange } from "@starter/core";
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
export function PrivateDataCard(): React.JSX.Element | null {
  const { user } = useAuth();
  return user ? <PrivateDataForUser key={user.id} id={user.id} /> : null;
}
function PrivateDataForUser({ id }: { id: string }): React.JSX.Element {
  const t = useT("settings");
  const native = useIsTokenShell();
  const account = trpc.privacy.identity.useQuery({ userId: id }, { retry: false });
  const enroll = trpc.privacy.enroll.useMutation();
  const updateIdentity = trpc.privacy.updateIdentity.useMutation();
  const [draft, setDraft] = React.useState<Enrollment | null>(null);
  const [confirmation, setConfirmation] = React.useState("");
  const [recovery, setRecovery] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [keyFingerprint, setKeyFingerprint] = React.useState("");
  const [, redraw] = React.useReducer((v: number) => v + 1, 0);
  React.useEffect(() => subscribePrivateSession(redraw), []);
  React.useEffect(() => {
    const key = account.data?.identity.publicKey;
    if (key) void fingerprint(key).then(setKeyFingerprint);
  }, [account.data]);
  const current = privateSession(id), identity = account.data?.identity;
  const run = async (task: () => Promise<void>) => {
    setPending(true); setProblem(null);
    try { await task(); } catch { setProblem(t("privateData.failed")); } finally { setPending(false); }
  };
  return <Card data-testid="private-data-settings">
    <CardHeader><CardTitle>{t("privateData.title")}</CardTitle><CardDescription>{t("privateData.description")}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t("privateData.recoveryExplanation")}</p>
      {native && <p className="max-w-prose text-sm text-muted-foreground">{t("privateData.nativePasskeys")}</p>}
      {!identity && !draft && <Button variant="outline" disabled={pending || account.isLoading || account.isError} onClick={() => void run(async () => setDraft(await newPrivateIdentity(id)))}>{t("privateData.prepare")}</Button>}
      {draft && <div className="max-w-xl space-y-3">
        <p className="text-sm">{t("privateData.saveRecovery")}</p>
        <code className="block break-all rounded-md bg-muted p-3 text-sm select-all">{draft.recoveryKey}</code>
        <Button variant="outline" onClick={() => downloadBlob("trackyourtime-recovery-key.json", new Blob([JSON.stringify({ format: "trackyourtime-recovery-key-v1", userId: id, server: privateDataOrigin(), recoveryKey: draft.recoveryKey }, null, 2)], { type: "application/json" }))}>{t("privateData.downloadRecovery")}</Button>
        <Label htmlFor="private-confirm">{t("privateData.confirmRecovery")}</Label>
        <Input id="private-confirm" value={confirmation} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />
        <Button disabled={pending || confirmation.trim() !== draft.recoveryKey.slice(-8)} onClick={() => void run(async () => {
          draft.assertCurrent(); await enroll.mutateAsync({ identity: draft.identity }); draft.assertCurrent(); installPrivateSession(id, draft.secrets); setDraft(null); setConfirmation(""); await account.refetch();
        })}>{t("privateData.finishSetup")}</Button>
      </div>}
      {identity && !current && <div className="max-w-xl space-y-3">
        <Button variant="outline" disabled={native || pending || identity.passkeys.length === 0} onClick={() => void run(() => unlockWithSavedPasskey(id, identity))}>{t("privateData.unlockPasskey")}</Button>
        <Label htmlFor="private-recovery">{t("privateData.recoveryKey")}</Label>
        <Input id="private-recovery" type="password" autoComplete="off" value={recovery} onChange={(event) => setRecovery(event.target.value)} />
        <Button variant="outline" disabled={pending || recovery.trim().length !== 43} onClick={() => void run(async () => { await unlockPrivateRecovery(id, identity, recovery); setRecovery(""); })}>{t("privateData.unlockRecovery")}</Button>
      </div>}
      {identity && current && <div className="space-y-3">
        <p role="status" className="text-sm">{t("privateData.unlocked")}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={native || pending} onClick={() => void run(async () => {
          const assertCurrent = privateOperationScope(id);
          const listed = await authClient.passkey.listUserPasskeys();
          if (listed.error) throw new Error("Could not load passkeys");
          const available = (listed.data ?? []).filter((p) => !identity.passkeys.some((saved) => saved.credentialId === p.credentialID));
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
            const next = { ...identity, passkeys: [...identity.passkeys, { credentialId, envelope: await wrapIdentityWithPrf(id, secret, identity) }] };
            const revision = account.data!.revision;
            const signature = await signPrivateChange(current.signingPrivateKey, { userId: id, revision, identity: next });
            assertCurrent(); if (privateSession(id) !== current) throw new Error("Private data is locked");
            await updateIdentity.mutateAsync({ identity: next, revision, signature }); await account.refetch();
          } finally { secret.fill(0); }
        })}>{t("privateData.addPasskey")}</Button><Button variant="outline" onClick={lockPrivateData}>{t("privateData.lock")}</Button></div>
      </div>}
      <PrivateActivity userId={id} />
      {keyFingerprint && <p className="max-w-xl break-all text-xs text-muted-foreground">{t("privateData.fingerprint", { fingerprint: keyFingerprint })}</p>}
      {(problem || account.isError) && <p role="alert" className="text-sm text-destructive">{problem ?? t("privateData.failed")}</p>}
    </CardContent>
  </Card>;
}
