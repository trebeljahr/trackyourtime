"use client";

import * as React from "react";
import { ArrowLeft, FilePlus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/use-t";
import { useServerSupports } from "@/lib/server-level";
import { cn } from "@/lib/utils";
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
  const followThrough = useServerSupports("invoices.followThrough");
  const [overdue, setOverdue] = React.useState(false);
  const list = trpc.invoices.list.useInfiniteQuery(
    followThrough ? { overdue } : INVOICE_LIST_INPUT,
    { getNextPageParam: (page) => page.nextCursor },
  );
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const detail = trpc.invoices.get.useQuery(
    { id: selectedId ?? "" },
    { enabled: selectedId !== null },
  );
  const detailRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (selectedId && window.matchMedia("(width < 40rem)").matches) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start" });
    }
  }, [selectedId]);
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
    setSelectedId(linkedId);
  }

  const invoices: InvoiceRow[] =
    list.data?.pages.flatMap((page) => page.invoices) ?? [];
  // Fetch selected ids independently so correction links survive filters and pagination.
  const selected =
    detail.data ??
    invoices.find((invoice) => invoice.id === selectedId) ??
    null;

  return (
    <div className="space-y-6" data-testid="invoices-screen">
      <div className="flex items-center justify-between gap-2">
        <p
          className="text-sm text-muted-foreground"
          data-testid="invoices-count"
        >
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

      {followThrough ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => setOverdue(e.target.checked)}
          />
          {t("followThrough.overdueOnly")}
        </label>
      ) : null}
      <div className={cn(selected && "hidden sm:block")}>
        <InvoiceList
          invoices={invoices}
          isLoading={list.isPending}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={() => setCreating("time")}
        />
      </div>
      {list.hasNextPage ? (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t("followThrough.loadMore")}
        </Button>
      ) : null}
      {selected ? (
        <div
          ref={detailRef}
          tabIndex={-1}
          className="space-y-3 scroll-mt-[calc(var(--app-header-offset,3.5rem)+1rem)] outline-none"
        >
          <Button
            variant="ghost"
            className="sm:hidden"
            onClick={() => setSelectedId(null)}
            data-testid="invoice-back"
          >
            <ArrowLeft className="size-4" />
            {t("invoices.backToList")}
          </Button>
          <InvoiceDetail
            invoice={selected}
            onSelect={setSelectedId}
            onClose={() => setSelectedId(null)}
            onDeleted={() => setSelectedId(null)}
          />
        </div>
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
