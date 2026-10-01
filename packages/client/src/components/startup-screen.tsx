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
      <div role="status" aria-live="polite" className="space-y-3 text-sm text-muted-foreground">
        <svg className="startup-timer mx-auto text-brand" viewBox="0 0 80 88" width="72" height="80" aria-hidden="true">
          <ellipse className="startup-timer__shadow" cx="40" cy="81" rx="19" ry="3" />
          <g className="startup-timer__watch">
            <path d="M40 10v8m-6-9h12m13 14 5-5" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
            <circle className="startup-timer__face" cx="40" cy="46" r="27" stroke="currentColor" strokeWidth="3" />
            <path d="M40 24v3m22 19h-3M40 68v-3M18 46h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".4" />
            <path className="startup-timer__hand" d="M40 46V32" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <circle cx="40" cy="46" r="3" fill="currentColor" />
            <path d="M34 55q6 6 12 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </g>
        </svg>
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
