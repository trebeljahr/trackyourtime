"use client";

import * as React from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import type { SaveState } from "@/components/settings/use-workspace-settings";

export type SaveIndicatorProps = {
  state: SaveState;
  className?: string;
  testId?: string;
};

/**
 * The stand-in for a Save button: settings write on change, so the only
 * feedback needed is a quiet acknowledgement that the write landed.
 */
export function SaveIndicator({
  state,
  className,
  testId = "save-indicator",
}: SaveIndicatorProps): React.JSX.Element {
  const t = useT("common");
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 text-xs transition-opacity",
        state === "idle" ? "opacity-0" : "opacity-100",
        state === "error" ? "text-destructive" : "text-muted-foreground",
        className
      )}
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-state={state}
    >
      {state === "saving" ? (
        <>
          <Loader2 className="size-3 animate-spin" />
          {t("status.saving")}
        </>
      ) : null}
      {state === "saved" ? (
        <>
          <Check className="size-3" />
          {t("status.saved")}
        </>
      ) : null}
      {state === "error" ? (
        <>
          <AlertCircle className="size-3" />
          {t("status.notSaved")}
        </>
      ) : null}
    </span>
  );
}

export type SettingRowProps = {
  title: string;
  description?: React.ReactNode;
  /** Associates the title with the control it labels. */
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
};

/** Label + explanation on the left, control on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
  className,
  testId,
}: SettingRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className
      )}
      data-testid={testId}
    >
      <div className="space-y-1">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-sm font-medium leading-none"
          >
            {title}
          </label>
        ) : (
          <p className="text-sm font-medium leading-none">{title}</p>
        )}
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 sm:min-w-56 sm:text-right">{children}</div>
    </div>
  );
}
