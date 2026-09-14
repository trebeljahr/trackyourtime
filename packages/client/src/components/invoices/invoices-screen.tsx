"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { InvoiceDetail } from "./invoice-detail";
import { InvoiceList } from "./invoice-list";
import { NewInvoiceDialog } from "./new-invoice-dialog";
import { INVOICE_LIST_INPUT, type InvoiceRow } from "./types";

/**
 * The invoices list, the create flow and the invoice detail view.
 *
 * The selected invoice is held in component state and rendered as a panel
 * under the list rather than at `/invoices/[id]`. The client is a STATIC
 * EXPORT: a dynamic segment would need `generateStaticParams`, and there is
 * no build-time list of an owner's invoice ids to generate from.
 */
export function InvoicesScreen(): React.JSX.Element {
  const t = useT("reports");
  const list = trpc.invoices.list.useQuery(INVOICE_LIST_INPUT);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const invoices: InvoiceRow[] = list.data?.invoices ?? [];
  // Resolved from the list rather than held as its own object, so a status
  // change or a delete landing in the cache is reflected here immediately
  // instead of leaving a stale copy on screen.
  const selected = invoices.find((invoice) => invoice.id === selectedId) ?? null;

  return (
    <div className="space-y-6" data-testid="invoices-screen">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" data-testid="invoices-count">
          {t("invoices.count", { count: invoices.length })}
        </p>
        <Button onClick={() => setCreating(true)} data-testid="new-invoice">
          <Plus className="size-4" />
          {t("invoices.newInvoice")}
        </Button>
      </div>

      <InvoiceList
        invoices={invoices}
        isLoading={list.isPending}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={() => setCreating(true)}
      />

      {selected ? (
        <InvoiceDetail
          invoice={selected}
          onClose={() => setSelectedId(null)}
          onDeleted={() => setSelectedId(null)}
        />
      ) : null}

      <NewInvoiceDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(invoice) => setSelectedId(invoice.id)}
      />
    </div>
  );
}
