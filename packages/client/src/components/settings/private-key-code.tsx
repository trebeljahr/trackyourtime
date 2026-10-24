"use client";
import * as React from "react";
import { decodeSecret, privateMemberKeyFingerprint } from "@starter/core";
import { privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { useT } from "@/i18n/use-t";

/** The API's advertised keys are not independent proof of their owner. Derive
 * this code from the unlocked root, whose public/private pair was checked at
 * unlock. Never send private JWK fields even to the fingerprint function. */
export function PrivateKeyCode({ userId }: { userId: string }): React.JSX.Element {
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  return <CurrentPrivateKeyCode key={`${userId}:${version}`} userId={userId} />;
}
function CurrentPrivateKeyCode({ userId }: { userId: string }): React.JSX.Element {
  const t = useT("settings");
  const root = privateSession(userId);
  const [code, setCode] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!root) return;
    let active = true;
    const check = privateOperationScope(userId);
    const coordinates = ({ kty, crv, x, y }: typeof root.privateKey) => ({ kty, crv, x, y });
    void privateMemberKeyFingerprint(privateDataOrigin(), { userId, publicKey: coordinates(root.privateKey), signingPublicKey: coordinates(root.signingPrivateKey) }).then((value) => {
      check();
      const hex = Array.from(decodeSecret(value, 32), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
      if (active && privateSession(userId) === root) setCode(hex.match(/.{1,8}/g)!.join(" "));
    }).catch(() => {
      if (active && privateSession(userId) === root) setFailed(true);
    });
    return () => { active = false; };
  }, [root, userId]);
  return <div className="max-w-xl space-y-2">
    <p className="text-sm font-medium">{t("privateData.verificationTitle")}</p>
    {code && <output aria-label={t("privateData.verificationTitle")} className="block break-words rounded-md bg-muted p-3 font-mono text-xs leading-6 select-all">{code}</output>}
    <p className="text-sm text-muted-foreground">{t(root ? "privateData.verificationHint" : "privateData.verificationLocked")}</p>
    {failed && <p role="alert" className="text-sm text-destructive">{t("privateData.failed")}</p>}
  </div>;
}
