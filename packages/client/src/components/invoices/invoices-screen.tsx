"use client";

import * as React from "react";
import { FilePlus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/use-t";
import { useServerSupports } from "@/lib/server-level";
import { trpc } from "@/lib/trpc";
import { InvoiceDetail } from "./invoice-detail";
import { InvoiceList } from "./invoice-list";
import { NewInvoiceDialog } from "./new-invoice-dialog";
import { INVOICE_LIST_INPUT, type InvoiceRow } from "./types";

/**
 * The invoices list, the create flow and the invoice detail view.
 *
 * The selected invoice is held in component state and rendered as a panel
 * under the list rather than at `/app/invoices/[id]`. The client is a STATIC
 * EXPORT: a dynamic segment would need `generateStaticParams`, and there is
 * no build-time list of an owner's invoice ids to generate from.
 */
export function InvoicesScreen(): React.JSX.Element {
  const t = useT("reports");
  const list = trpc.invoices.list.useQuery(INVOICE_LIST_INPUT);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Which create flow is open: over tracked time, or a blank invoice.
  const [creating, setCreating] = React.useState<"time" | "blank" | null>(null);
  const [linkedId, setLinkedId] = React.useState<string | null>(null);
  // A blank invoice needs `invoices.create` without a range, which an older
  // self-hosted server refuses; the button waits for one that answers it.
  const blankSupported = useServerSupports("invoices.lines");

  // `?invoice=<id>`: the way back from fixing billing data for one invoice.
  // Read from `location`, like settings `?tab=`, and applied once the list
  // has the invoice.
  React.useEffect(() => {
    // After mount, per the note above: read from `location` like settings
    // `?tab=`, which the prerendered HTML cannot have.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLinkedId(new URLSearchParams(window.location.search).get("invoice"));
  }, []);
  if (linkedId !== null && list.data) {
    setLinkedId(null);
    if (list.data.invoices.some((invoice) => invoice.id === linkedId)) setSelectedId(linkedId);
  }

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
        <div className="flex flex-wrap items-center gap-2">
          {blankSupported ? (
            <Button
              variant="outline"
              onClick={() => setCreating("blank")}
              data-testid="new-blank-invoice"
            >
              <FilePlus className="size-4" />
              {t("invoices.newBlankInvoice")}
            </Button>
          ) : null}
          <Button onClick={() => setCreating("time")} data-testid="new-invoice">
            <Plus className="size-4" />
            {t("invoices.newInvoice")}
          </Button>
        </div>
      </div>

      <InvoiceList
        invoices={invoices}
        isLoading={list.isPending}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={() => setCreating("time")}
      />

      {selected ? (
        <InvoiceDetail
          invoice={selected}
          onClose={() => setSelectedId(null)}
          onDeleted={() => setSelectedId(null)}
        />
      ) : null}

      <NewInvoiceDialog
        open={creating !== null}
        blank={creating === "blank"}
        onOpenChange={(open) => setCreating(open ? (creating ?? "time") : null)}
        onCreated={(invoice) => setSelectedId(invoice.id)}
      />
    </div>
  );
}
