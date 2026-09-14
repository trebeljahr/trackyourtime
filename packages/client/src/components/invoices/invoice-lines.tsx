"use client";

import * as React from "react";
import type { InvoiceLineItem } from "@starter/shared";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { formatHours, taxLabel, totalHours } from "./types";

export type InvoiceLinesProps = {
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  total: number;
  currency: string;
  /** Prefix for every test id, so preview and detail never collide. */
  testIdPrefix: string;
};

/**
 * Lines and totals — the same table for the preview and for the saved
 * document, because the whole promise of the preview is that it shows exactly
 * what will be persisted. Two renderings that could drift would break that.
 *
 * A group billed at two different rates arrives as two lines from the server;
 * that is intentional and is why the rate column is per-line rather than a
 * single figure in the header.
 */
export function InvoiceLines({
  lineItems,
  subtotal,
  taxRate,
  taxAmount,
  total,
  currency,
  testIdPrefix,
}: InvoiceLinesProps): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  const f = useFormat();
  const money = (amount: number): string => f.money(amount, currency);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border">
        <Table data-testid={`${testIdPrefix}-lines`}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("invoices.columns.line")}</TableHead>
              <TableHead className="text-right">{t("invoices.columns.hours")}</TableHead>
              <TableHead className="text-right">{tc("fields.rate")}</TableHead>
              <TableHead className="text-right">{tc("fields.amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lineItems.map((line) => (
              <TableRow key={line.key} data-testid={`${testIdPrefix}-line`}>
                <TableCell className="font-medium">{line.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatHours(line.hours, f.locale)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {money(line.hourlyRate)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(line.amount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <dl className="ml-auto grid w-full max-w-xs gap-1 text-sm">
        <div className="flex justify-between text-muted-foreground">
          <dt>{t("invoices.billedHours")}</dt>
          <dd
            className="tabular-nums"
            data-testid={`${testIdPrefix}-hours`}
          >
            {formatHours(totalHours(lineItems), f.locale)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>{t("invoices.subtotal")}</dt>
          <dd
            className="tabular-nums"
            data-testid={`${testIdPrefix}-subtotal`}
          >
            {money(subtotal)}
          </dd>
        </div>
        {taxRate === null ? null : (
          <div className="flex justify-between">
            <dt>{taxLabel(taxRate, f.locale)}</dt>
            <dd className="tabular-nums" data-testid={`${testIdPrefix}-tax`}>
              {money(taxAmount)}
            </dd>
          </div>
        )}
        <div className="flex justify-between border-t border-border pt-1 text-base font-semibold">
          <dt>{tc("fields.total")}</dt>
          <dd className="tabular-nums" data-testid={`${testIdPrefix}-total`}>
            {money(total)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
