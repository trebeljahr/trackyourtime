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
import { BusinessProfileCard } from "@/components/settings/business-profile-form";
import { NumberField } from "@/components/settings/number-field";
import { SaveIndicator, SettingRow } from "@/components/settings/setting-row";
import type { WorkspaceSettingsController } from "@/components/settings/use-workspace-settings";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";

/**
 * ISO 4217 codes offered in the picker. Any 3-letter code is valid server-side.
 * Names come from `Intl.DisplayNames` in the rendered language.
 */
export const CURRENCIES: readonly string[] = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "SGD",
  "HKD",
  "INR",
  "BRL",
  "MXN",
  "ZAR",
];

/** "Euro" / "Euro", "US Dollar" / "US-Dollar"; the code itself when Intl has no name. */
const currencyName = (code: string, intlLocale: string): string => {
  try {
    return new Intl.DisplayNames([intlLocale], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
};

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
  const t = useT("settings");
  const f = useFormat();

  // A currency the workspace already uses but that isn't in the curated list
  // must still be selectable, or the <Select> would silently drop it.
  const options = React.useMemo(() => {
    const codes = CURRENCIES.includes(settings.currency)
      ? CURRENCIES
      : [settings.currency, ...CURRENCIES];
    return codes.map((code) => ({ code, label: currencyName(code, f.intlLocale) }));
  }, [settings.currency, f.intlLocale]);

  return (
    <div className="space-y-6">
      <Card data-testid="settings-billing">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{t("billing.title")}</CardTitle>
            <CardDescription>{t("billing.description")}</CardDescription>
          </div>
          <SaveIndicator state={saveState} testId="billing-save-indicator" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="divide-y divide-border">
            <SettingRow
              title={t("billing.defaultRate.title")}
              description={t("billing.defaultRate.description")}
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
                aria-label={t("billing.defaultRate.title")}
              />
            </SettingRow>

            <SettingRow
              title={t("billing.currency.title")}
              description={t("billing.currency.description", {
                sample: f.money(1234.5, settings.currency),
              })}
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
                  aria-label={t("billing.currency.title")}
                  data-testid="currency-select"
                >
                  <SelectValue placeholder={t("billing.currency.placeholder")} />
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
            <p className="min-w-0">{t("billing.snapshotNote")}</p>
          </div>
        </CardContent>
      </Card>
      <BusinessProfileCard />
    </div>
  );
}
