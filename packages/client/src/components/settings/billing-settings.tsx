"use client";

import * as React from "react";
import { Info } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/format";
import { BusinessProfileCard } from "@/components/settings/business-profile-form";
import { NumberField } from "@/components/settings/number-field";
import { SaveIndicator, SettingRow } from "@/components/settings/setting-row";
import type { WorkspaceSettingsController } from "@/components/settings/use-workspace-settings";

/** ISO 4217 codes offered in the picker. Any 3-letter code is valid server-side. */
export const CURRENCIES: { code: string; label: string }[] = [
  { code: "EUR", label: "Euro" },
  { code: "USD", label: "US Dollar" },
  { code: "GBP", label: "British Pound" },
  { code: "CHF", label: "Swiss Franc" },
  { code: "SEK", label: "Swedish Krona" },
  { code: "NOK", label: "Norwegian Krone" },
  { code: "DKK", label: "Danish Krone" },
  { code: "PLN", label: "Polish Zloty" },
  { code: "CZK", label: "Czech Koruna" },
  { code: "CAD", label: "Canadian Dollar" },
  { code: "AUD", label: "Australian Dollar" },
  { code: "NZD", label: "New Zealand Dollar" },
  { code: "JPY", label: "Japanese Yen" },
  { code: "SGD", label: "Singapore Dollar" },
  { code: "HKD", label: "Hong Kong Dollar" },
  { code: "INR", label: "Indian Rupee" },
  { code: "BRL", label: "Brazilian Real" },
  { code: "MXN", label: "Mexican Peso" },
  { code: "ZAR", label: "South African Rand" },
];

export type BillingSettingsProps = {
  controller: WorkspaceSettingsController;
};

/**
 * Default rate + currency, the one sentence that explains snapshotting, and
 * the business profile every new invoice copies.
 */
export function BillingSettings({
  controller,
}: BillingSettingsProps): React.JSX.Element {
  const { settings, saveState, save } = controller;

  // A currency the workspace already uses but that isn't in the curated list
  // must still be selectable, or the <Select> would silently drop it.
  const options = React.useMemo(() => {
    const known = CURRENCIES.some((item) => item.code === settings.currency);
    return known
      ? CURRENCIES
      : [{ code: settings.currency, label: settings.currency }, ...CURRENCIES];
  }, [settings.currency]);

  return (
    <div className="space-y-6">
      <Card data-testid="settings-billing">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Billing</CardTitle>
            <CardDescription>
              The rate applied to billable time when a project has no rate of its
              own.
            </CardDescription>
          </div>
          <SaveIndicator state={saveState} testId="billing-save-indicator" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="divide-y divide-border">
            <SettingRow
              title="Default hourly rate"
              description="Used whenever a billable entry belongs to a project without its own rate."
              htmlFor="default-hourly-rate"
              testId="setting-default-rate"
            >
              <NumberField
                id="default-hourly-rate"
                value={settings.defaultHourlyRate}
                onCommit={(defaultHourlyRate) => save({ defaultHourlyRate })}
                min={0}
                max={1_000_000}
                step={0.01}
                suffix={settings.currency}
                testId="default-hourly-rate"
                aria-label="Default hourly rate"
              />
            </SettingRow>

            <SettingRow
              title="Currency"
              description={`Amounts render as ${formatMoney(1234.5, settings.currency)}.`}
              htmlFor="workspace-currency"
              testId="setting-currency"
            >
              <Select
                value={settings.currency}
                onValueChange={(currency) => save({ currency })}
              >
                <SelectTrigger
                  id="workspace-currency"
                  className="sm:w-56"
                  aria-label="Currency"
                  data-testid="currency-select"
                >
                  <SelectValue placeholder="Select a currency" />
                </SelectTrigger>
                <SelectContent data-testid="currency-select-content">
                  {options.map((option) => (
                    <SelectItem
                      key={option.code}
                      value={option.code}
                      data-testid={`currency-option-${option.code}`}
                    >
                      <span className="font-medium">{option.code}</span>
                      <span className="ml-2 text-muted-foreground">
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </div>

          <div
            className="flex gap-3 rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
            data-testid="rate-snapshot-note"
          >
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>
              Changing the rate or currency only affects time you track from now
              on — each entry stores the rate and currency that applied when it
              was stopped, so past reports and invoices never move.
            </p>
          </div>
        </CardContent>
      </Card>
      <BusinessProfileCard />
    </div>
  );
}
