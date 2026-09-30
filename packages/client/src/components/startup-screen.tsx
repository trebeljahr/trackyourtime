"use client";

import { useEffect, useState } from "react";
import { BrandLockup } from "@/components/brand-lockup";
import { useT } from "@/i18n/use-t";

export function StartupScreen() {
  const t = useT("shell");
  const tc = useT("common");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <BrandLockup />
      <div
        role="status"
        aria-live="polite"
        className="space-y-3 text-sm text-muted-foreground"
      >
        <div
          aria-hidden="true"
          className="mx-auto size-5 animate-spin rounded-full border-2 border-muted border-t-brand motion-reduce:animate-none"
        />
        <p>{slow ? t("startup.slow") : tc("status.loading")}</p>
      </div>
      {slow && (
        <button
          className="rounded-md border px-4 py-2 text-sm"
          onClick={() => window.location.reload()}
        >
          {tc("actions.retry")}
        </button>
      )}
    </div>
  );
}
