"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export type CopyFieldProps = {
  value: string;
  label: string;
  testId: string;
  className?: string;
};

/**
 * A read-only link with a Copy button beside it.
 *
 * The field stays selectable on purpose: the Clipboard API is refused in an
 * insecure context and in some WebViews, and then the only way to get the link
 * out is to select it — which is what a failed copy does for the person.
 */
export function CopyField({
  value,
  label,
  testId,
  className,
}: CopyFieldProps): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = React.useState(false);

  const selectAll = (): void => {
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      selectAll();
      toast.error(t("invite.copyFailed"));
    }
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Input
        ref={inputRef}
        readOnly
        value={value}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="font-mono text-xs"
        data-testid={testId}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void copy()}
        data-testid={`${testId}-copy`}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? tc("actions.copied") : tc("actions.copy")}
      </Button>
    </div>
  );
}
