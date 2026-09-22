"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

export type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /** The `<input>` itself. The frame around field and toggle is fixed. */
  className?: string;
};

/**
 * A password field with a show/hide toggle of our own.
 *
 * The toggle flips the input's `type` between `password` and `text`, so a
 * value the person is typing stays put — no controlled-value juggling. It is
 * out of the tab order (the field already submits on Enter) and does not
 * steal focus on click, so pressing it never blurs the field mid-entry.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  PasswordInputProps
>(function PasswordInput({ className, disabled, ...props }, ref) {
  const tc = useT("common");
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative flex w-full items-center">
      <input
        ref={ref}
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm",
          className,
        )}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? tc("a11y.hidePassword") : tc("a11y.showPassword")}
        aria-pressed={visible}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((current) => !current)}
        className="absolute right-0 flex h-10 w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        data-testid="password-toggle"
      >
        {visible ? (
          <EyeOff className="size-4" />
        ) : (
          <Eye className="size-4" />
        )}
      </button>
    </div>
  );
});
