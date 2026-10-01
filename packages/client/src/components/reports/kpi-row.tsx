"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type KpiItem = {
  label: string;
  /** Already formatted - reports never render raw seconds. */
  value: string;
  /** Secondary line, e.g. "62% of tracked time". */
  hint?: string;
  icon?: LucideIcon;
  testId: string;
};

export type KpiRowProps = {
  items: KpiItem[];
  className?: string;
};

/** The headline figures strip that opens every report. */
export function KpiRow({ items, className }: KpiRowProps): React.JSX.Element {
  return (
    <div
      className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}
      data-testid="kpi-row"
      data-count={items.length}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.testId}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {Icon ? <Icon className="size-3.5" /> : null}
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p
                className="text-2xl font-semibold tabular-nums"
                data-testid={item.testId}
              >
                {item.value}
              </p>
              <p className="mt-1 min-h-4 text-xs text-muted-foreground">
                {item.hint ?? ""}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
