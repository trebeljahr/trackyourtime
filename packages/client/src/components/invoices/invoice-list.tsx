"use client";

import * as React from "react";
import { FileText, Plus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { cn } from "@/lib/utils";
import {
  formatDate,
  statusBadgeTone,
  statusLabel,
  type InvoiceRow,
} from "./types";

export type InvoiceListProps = {
  invoices: InvoiceRow[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

/**
 * The ledger.
 *
 * Money is formatted with the invoice's OWN snapshotted currency, not the
 * workspace's current one: a document issued in USD stays a USD document
 * after the workspace switches to EUR.
 */
export function InvoiceList({
  invoices,
  isLoading,
  selectedId,
  onSelect,
  onCreate,
}: InvoiceListProps): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  const f = useFormat();

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="invoices-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title={t("invoices.emptyTitle")}
        description={t("invoices.emptyDescription")}
        action={
          <Button onClick={onCreate} data-testid="invoices-empty-create">
            <Plus className="size-4" />
            {t("invoices.newInvoice")}
          </Button>
        }
        testId="invoices-empty"
      />
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table data-testid="invoices-table">
        <TableHeader>
          <TableRow>
            <TableHead>{t("invoices.columns.number")}</TableHead>
            <TableHead>{tc("fields.client")}</TableHead>
            <TableHead>{t("invoices.columns.issued")}</TableHead>
            <TableHead>{t("invoices.columns.due")}</TableHead>
            <TableHead className="text-right">{tc("fields.total")}</TableHead>
            <TableHead>{t("invoices.columns.status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice) => (
            <TableRow
              key={invoice.id}
              onClick={() => onSelect(invoice.id)}
              className={cn(
                "cursor-pointer",
                invoice.id === selectedId && "bg-muted/60",
              )}
              data-testid={`invoice-row-${invoice.id}`}
              data-status={invoice.status}
            >
              <TableCell className="font-medium">
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(invoice.id);
                  }}
                  data-testid={`invoice-open-${invoice.id}`}
                >
                  {invoice.number}
                </button>
              </TableCell>
              <TableCell data-testid={`invoice-client-${invoice.id}`}>
                {invoice.clientName}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(invoice.issueDate, f.locale)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(invoice.dueDate, f.locale)}
              </TableCell>
              <TableCell
                className="text-right tabular-nums"
                data-testid={`invoice-total-${invoice.id}`}
              >
                {f.money(invoice.total, invoice.currency)}
              </TableCell>
              <TableCell>
                <Badge
                  variant={statusBadgeTone(invoice.status)}
                  data-testid={`invoice-status-${invoice.id}`}
                >
                  {statusLabel(invoice.status, f.locale)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
