"use client";

import { useEffect, useRef, useState } from "react";
import { useApiOrigin } from "@/hooks/use-api-origin";
import { useT } from "@/i18n/use-t";
import { canUseAndroidPasswords, getAndroidPassword, type SavedPassword } from "@/lib/android-password-manager";

export function AndroidPasswordFill({ onFill, disabled }: {
  onFill: (credential: SavedPassword) => void;
  disabled: boolean;
}) {
  const { ready } = useApiOrigin();
  const t = useT("shell");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"none" | "unavailable" | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  if (!ready || !canUseAndroidPasswords()) return null;

  const fill = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await getAndroidPassword(controller.signal);
      if (result && !controller.signal.aborted) onFill(result);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError((caught as { code?: string })?.code === "NO_CREDENTIAL" ? "none" : "unavailable");
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button type="button" disabled={disabled || busy} onClick={() => void fill()}
        className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input text-sm font-medium hover:bg-muted disabled:opacity-50"
        data-testid="android-password-fill">
        {t(busy ? "auth.login.passwordOpening" : "auth.login.passwordFill")}
      </button>
      {error && <p role="status" className="text-sm text-muted-foreground">
        {t(error === "none" ? "auth.login.passwordNone" : "auth.login.passwordUnavailable")}
      </p>}
    </div>
  );
}
