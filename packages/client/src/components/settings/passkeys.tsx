"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/setting-row";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t";
import { useIsTokenShell } from "@/hooks/use-shell";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { addPasskeyWithKeys, revokePasskey, type PasskeyKeyState } from "@/lib/passkey-keys";

type SavedPasskey = { id: string; name?: string; credentialID?: string };

export function PasskeysRow(): React.JSX.Element {
  const t = useT("settings");
  const native = useIsTokenShell();
  const [keys, setKeys] = React.useState<SavedPasskey[]>([]);
  const [name, setName] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [supported, setSupported] = React.useState(false);
  const [added, setAdded] = React.useState<PasskeyKeyState | null>(null);
  const { user } = useAuth();
  // Which passkeys hold a sealed copy of the keys (lib/passkey-keys.ts).
  const account = trpc.privacy.identity.useQuery({ userId: user?.id ?? "pending" }, { enabled: !!user && !native, retry: false });
  const opensKeys = (key: SavedPasskey) => !!key.credentialID && !!account.data?.identity.passkeys.some((saved) => saved.credentialId === key.credentialID);
  const reload = React.useCallback(async () => {
    const result = await authClient.passkey.listUserPasskeys();
    if (result.error) throw new Error("Could not load passkeys");
    setKeys(result.data ?? []);
  }, []);
  React.useEffect(() => {
    // Browser capability must not change the prerendered HTML before hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(!native && typeof PublicKeyCredential !== "undefined" && window.isSecureContext);
    if (!native) void reload().catch(() => setError(true));
  }, [native, reload]);
  const run = async (task: () => Promise<void>) => {
    setPending(true); setError(false);
    try { await task(); await reload(); await account.refetch(); } catch { setError(true); } finally { setPending(false); }
  };
  return <SettingRow title={t("passkeys.title")} description={native ? t("passkeys.browser") : t("passkeys.description")} testId="setting-passkeys">
    <div className="w-full max-w-sm space-y-3">
      {keys.map((key) => <div key={key.id} className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm">{key.name || t("passkeys.unnamed")}</span>
          {account.data && <span className="block text-xs text-muted-foreground" data-testid="passkey-key-state">{t(opensKeys(key) ? "passkeys.opensData" : "passkeys.signInOnly")}</span>}
        </span>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => void run(async () => {
          const result = await authClient.passkey.deletePasskey({ id: key.id });
          if (result.error) throw new Error("Could not remove passkey");
          // A removed passkey must open nothing any more.
          if (user && key.credentialID) await revokePasskey(user.id, key.credentialID).catch(() => undefined);
        })}>{t("passkeys.remove")}</Button>
      </div>)}
      <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder={t("passkeys.name")} aria-label={t("passkeys.name")} disabled={!supported || pending} />
      <Button variant="outline" disabled={!supported || pending} data-testid="passkey-add" onClick={() => void run(async () => {
        if (!user) throw new Error("Sign in first");
        setAdded(await addPasskeyWithKeys(user.id, name.trim() || undefined));
        setName("");
      })}>{pending ? t("passkeys.waiting") : t("passkeys.add")}</Button>
      {added === "no-prf" && <p role="status" className="text-sm" data-testid="passkey-added-state">{t("passkeys.addedNoPrf")}</p>}
      {added === "keys-locked" && <p role="status" className="text-sm" data-testid="passkey-added-state">{t("passkeys.addedLocked")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t("passkeys.failed")}</p>}
    </div>
  </SettingRow>;
}
