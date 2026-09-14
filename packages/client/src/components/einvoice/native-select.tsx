"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A platform `<select>` styled like `Input`.
 *
 * Used by the e-invoice forms instead of the Radix `Select`: these controls
 * sit in dense tables (one per invoice line) and in forms that run inside the
 * phone shells, where the OS picker is the better control, and a native
 * element needs no portal to be tested or driven by E2E `selectOption`.
 */
export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
NativeSelect.displayName = "NativeSelect";
