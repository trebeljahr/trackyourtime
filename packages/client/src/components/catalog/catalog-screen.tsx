"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n/use-t";

export type CatalogScreenProps = {
  title: string;
  description: string;
  /** Label of the primary "new …" button in the header. */
  actionLabel: string;
  onAction: () => void;
  actionTestId: string;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  /** Extra filters, rendered between the search box and the archived switch. */
  filters?: React.ReactNode;
  /** One-line roll-up under the toolbar ("12 projects · 40h tracked"). */
  summary: React.ReactNode;
  hasError: boolean;
  children: React.ReactNode;
  testId: string;
};

/**
 * The frame every manage screen shares: title, primary action, search,
 * archived toggle and a summary line. Only one of these is mounted at a
 * time, so the switch can keep a fixed id.
 */
export function CatalogScreen({
  title,
  description,
  actionLabel,
  onAction,
  actionTestId,
  search,
  onSearchChange,
  searchPlaceholder,
  showArchived,
  onShowArchivedChange,
  filters,
  summary,
  hasError,
  children,
  testId,
}: CatalogScreenProps): React.JSX.Element {
  const t = useT("catalog");
  return (
    <div className="space-y-6" data-testid={testId}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button onClick={onAction} data-testid={actionTestId}>
          <Plus className="size-4" />
          {actionLabel}
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-8"
            onChange={(event) => onSearchChange(event.target.value)}
            data-testid="catalog-search"
          />
        </div>

        {filters}

        <div className="flex items-center gap-2">
          <Switch
            id="show-archived"
            checked={showArchived}
            onCheckedChange={onShowArchivedChange}
            data-testid="catalog-show-archived"
          />
          <Label htmlFor="show-archived" className="text-sm font-normal">
            {t("screen.showArchived")}
          </Label>
        </div>
      </div>

      {hasError ? (
        <p
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
          data-testid="catalog-error"
        >
          {t("screen.loadError")}
        </p>
      ) : null}

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground" data-testid="catalog-summary">
          {summary}
        </p>
        {children}
      </div>
    </div>
  );
}
