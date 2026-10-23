"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/setting-row";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t";
import { useIsTokenShell } from "@/hooks/use-shell";

type SavedPasskey = { id: string; name?: string };

export function PasskeysRow(): React.JSX.Element {
  const t = useT("settings");
  const native = useIsTokenShell();
  const [keys, setKeys] = React.useState<SavedPasskey[]>([]);
  const [name, setName] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [supported, setSupported] = React.useState(false);
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
    try { await task(); await reload(); } catch { setError(true); } finally { setPending(false); }
  };
  return <SettingRow title={t("passkeys.title")} description={native ? t("passkeys.browser") : t("passkeys.description")} testId="setting-passkeys">
    <div className="w-full max-w-sm space-y-3">
      {keys.map((key) => <div key={key.id} className="flex items-center justify-between gap-3">
        <span className="truncate text-sm">{key.name || t("passkeys.unnamed")}</span>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => void run(async () => {
          const result = await authClient.passkey.deletePasskey({ id: key.id });
          if (result.error) throw new Error("Could not remove passkey");
        })}>{t("passkeys.remove")}</Button>
      </div>)}
      <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder={t("passkeys.name")} aria-label={t("passkeys.name")} disabled={!supported || pending} />
      <Button variant="outline" disabled={!supported || pending} data-testid="passkey-add" onClick={() => void run(async () => {
        const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined, extensions: { prf: {} } } as unknown as Parameters<typeof authClient.passkey.addPasskey>[0]);
        if (result.error) throw new Error("Could not register passkey");
        setName("");
      })}>{pending ? t("passkeys.waiting") : t("passkeys.add")}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{t("passkeys.failed")}</p>}
    </div>
  </SettingRow>;
}
