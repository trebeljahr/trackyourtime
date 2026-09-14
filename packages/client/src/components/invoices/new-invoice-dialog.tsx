"use client";

import * as React from "react";
import { AlertTriangle, Info, Loader2, ShieldCheck } from "lucide-react";
import { dueDateFromTerms } from "@starter/shared";

import { CLIENT_LIST_INPUT } from "@/components/catalog/types";
import {
  DateRangePicker,
  rangeForPreset,
  type DateRange,
} from "@/components/date-range-picker";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import { InvoiceIdentityWarnings } from "./identity-warnings";
import { InvoiceLines } from "./invoice-lines";
import {
  defaultInvoiceDates,
  emptyPreviewReason,
  exclusionNotices,
  parseTaxRate,
  previewIsBillable,
  reconcileDueDate,
  type InvoiceGroupBy,
  type InvoiceRow,
} from "./types";
import { useInvoiceMutations, type CreateInvoiceVars } from "./use-invoices";

export type NewInvoiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created invoice so the screen can select it. */
  onCreated: (invoice: InvoiceRow) => void;
};

const GROUP_OPTIONS: { id: InvoiceGroupBy; label: string }[] = [
  { id: "project", label: "One line per project" },
  { id: "task", label: "One line per task" },
];

/**
 * The create flow.
 *
 * The body is only mounted while the dialog is open, so every field
 * re-initialises on each open without an effect syncing state — an invoice
 * half-built from last week's client and this week's range is the kind of
 * mistake that reaches a customer.
 */
export function NewInvoiceDialog({
  open,
  onOpenChange,
  onCreated,
}: NewInvoiceDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        data-testid="invoice-dialog"
      >
        {open ? (
          <NewInvoiceForm
            onCreated={(invoice) => {
              onCreated(invoice);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type NewInvoiceFormProps = {
  onCreated: (invoice: InvoiceRow) => void;
  onCancel: () => void;
};

/**
 * PREVIEW IS FREE, CREATE IS NOT.
 *
 * Everything above the separator re-runs a server-side dry run on every change
 * and writes nothing. The button below it allocates a number, persists a
 * document and stamps `invoiceId` on every entry it bills — the point at which
 * that time stops being billable, permanently. So the two are not one button
 * at the bottom of a form: creating is reached through its own confirmation
 * strip that restates the money and says plainly what it costs, and ANY edit
 * to the form drops back out of it. You confirm the numbers you are looking
 * at, never the ones you were looking at a moment ago.
 */
function NewInvoiceForm({
  onCreated,
  onCancel,
}: NewInvoiceFormProps): React.JSX.Element {
  const format = useFormatSettings();
  const { createInvoice, isCreating } = useInvoiceMutations();

  const [clientId, setClientId] = React.useState<string | null>(null);
  const [range, setRange] = React.useState<DateRange>(() =>
    rangeForPreset("thisMonth", format.weekStartsOn),
  );
  const [groupBy, setGroupBy] = React.useState<InvoiceGroupBy>("project");
  const [taxInput, setTaxInput] = React.useState("");
  const [dates, setDates] = React.useState(() => defaultInvoiceDates());
  // Once the person picks a due date it is theirs; until then it follows the
  // business profile's payment terms, when there are any.
  const [dueTouched, setDueTouched] = React.useState(false);
  const t = useT("reports");
  const [notes, setNotes] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);

  const clients = trpc.clients.list.useQuery(CLIENT_LIST_INPUT);
  // A refusal (a role that may not read the profile) simply means no terms
  // and no warning — creating the invoice is decided on the server.
  const profile = trpc.settings.businessProfile.useQuery(undefined, {
    retry: false,
  });
  const selectedClient =
    (clients.data ?? []).find((client) => client.id === clientId) ?? null;
  const termsDays = profile.data?.paymentTermsDays ?? null;
  const suggestedDue = dueTouched
    ? null
    : dueDateFromTerms(dates.issueDate, termsDays);
  const dueDate = suggestedDue ?? dates.dueDate;
  const clientOptions = React.useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => !client.archived)
        .map((client) => ({
          value: client.id,
          label: client.name,
          color: client.color,
        })),
    [clients.data],
  );

  const tax = parseTaxRate(taxInput);
  const taxRate = tax.ok ? tax.value : null;
  const taxError = tax.ok ? null : tax.error;

  // A dry run, re-fetched on every edit. `enabled` keeps it from firing with a
  // placeholder client id, and `staleTime: 0` keeps it honest — another tab
  // may have invoiced this range since the last look.
  const preview = trpc.invoices.preview.useQuery(
    {
      clientId: clientId ?? "",
      from: range.from,
      to: range.to,
      groupBy,
      taxRate,
    },
    { enabled: clientId !== null && tax.ok, staleTime: 0 },
  );

  const data = preview.data;
  const billable = previewIsBillable(data);
  const notices = data ? exclusionNotices(data) : [];

  const setIssueDate = (next: string): void => {
    if (next === "") return;
    setConfirming(false);
    setDates((current) => ({
      issueDate: next,
      dueDate: reconcileDueDate(next, dueTouched ? current.dueDate : dueDate),
    }));
  };

  const setDueDate = (next: string): void => {
    if (next === "") return;
    setConfirming(false);
    setDueTouched(true);
    setDates((current) => ({
      issueDate: current.issueDate,
      // The server refuses a due date before the issue date; clamp rather
      // than send a request that can only come back as an error.
      dueDate: next < current.issueDate ? current.issueDate : next,
    }));
  };

  const submit = async (): Promise<void> => {
    if (clientId === null || !tax.ok || !billable) return;
    const vars: CreateInvoiceVars = {
      clientId,
      from: range.from,
      to: range.to,
      groupBy,
      taxRate,
      issueDate: dates.issueDate,
      dueDate,
      ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
    };
    const created = await createInvoice(vars);
    if (!created) {
      // The toast already said why. Stay open with the form intact so the
      // range can be narrowed, or the preview reloaded, and tried again.
      setConfirming(false);
      return;
    }
    onCreated(created);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New invoice</DialogTitle>
        <DialogDescription>
          Preview costs nothing and changes nothing. Creating the invoice bills
          the time on it — that time can never be invoiced again.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="invoice-client">Client</Label>
          <Combobox
            id="invoice-client"
            className="w-full"
            options={clientOptions}
            value={clientId}
            onChange={(next) => {
              setConfirming(false);
              setClientId(next);
            }}
            placeholder="Select a client"
            searchPlaceholder="Search clients..."
            emptyText="No clients yet."
            data-testid="invoice-client-combobox"
          />
        </div>

        <div className="space-y-2">
          <Label>Billed range</Label>
          <DateRangePicker
            value={range}
            onChange={(next) => {
              setConfirming(false);
              setRange(next);
            }}
            weekStartsOn={format.weekStartsOn}
            className="w-full"
            testId="invoice-range"
          />
        </div>

        <div className="space-y-2">
          <Label>Lines</Label>
          <div className="flex gap-2" data-testid="invoice-groupby">
            {GROUP_OPTIONS.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={groupBy === option.id ? "secondary" : "outline"}
                onClick={() => {
                  setConfirming(false);
                  setGroupBy(option.id);
                }}
                aria-pressed={groupBy === option.id}
                data-testid={`invoice-groupby-${option.id}`}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice-tax">Tax rate (%)</Label>
          <Input
            id="invoice-tax"
            inputMode="decimal"
            placeholder="No tax"
            value={taxInput}
            onChange={(event) => {
              setConfirming(false);
              setTaxInput(event.target.value);
            }}
            data-testid="invoice-tax-input"
          />
          {taxError ? (
            <p className="text-sm text-destructive" data-testid="invoice-tax-error">
              {taxError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Leave empty for no tax line. 0 prints a real 0% line.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice-issue-date">Issue date</Label>
          <Input
            id="invoice-issue-date"
            type="date"
            value={dates.issueDate}
            onChange={(event) => setIssueDate(event.target.value)}
            data-testid="invoice-issue-date"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice-due-date">Due date</Label>
          <Input
            id="invoice-due-date"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            data-testid="invoice-due-date"
          />
          {suggestedDue !== null && termsDays !== null ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="invoice-due-from-terms"
            >
              {t("invoiceIdentity.dueFromTerms", { days: termsDays })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="invoice-notes">Notes (optional)</Label>
        <Textarea
          id="invoice-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Payment terms, a reference, anything the customer needs to see."
          data-testid="invoice-notes"
        />
      </div>

      <InvoiceIdentityWarnings
        profile={profile.data}
        client={selectedClient}
      />

      <Separator />

      <section className="space-y-3" data-testid="invoice-preview">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Preview</h3>
          {data ? (
            <span
              className="text-xs text-muted-foreground"
              data-testid="invoice-preview-number"
            >
              Next number: {data.suggestedNumber}
            </span>
          ) : null}
        </header>

        {clientId === null ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="invoice-preview-idle"
          >
            Pick a client to see what would be billed.
          </p>
        ) : !tax.ok ? (
          <p className="text-sm text-muted-foreground">
            Fix the tax rate to see the preview.
          </p>
        ) : preview.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Gathering billable time…
          </p>
        ) : preview.error ? (
          <p className="text-sm text-destructive" data-testid="invoice-preview-error">
            {preview.error.message}
          </p>
        ) : data ? (
          <>
            {notices.map((notice) => (
              <p
                key={notice.id}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  notice.tone === "warning"
                    ? "border-destructive/40 text-destructive"
                    : "border-border text-muted-foreground",
                )}
                data-testid={
                  notice.id === "missing-rate"
                    ? "invoice-preview-skipped-rate"
                    : "invoice-preview-skipped-invoiced"
                }
              >
                {notice.tone === "warning" ? (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                )}
                <span>{notice.message}</span>
              </p>
            ))}

            {billable ? (
              <InvoiceLines
                lineItems={data.lineItems}
                subtotal={data.subtotal}
                taxRate={data.taxRate}
                taxAmount={data.taxAmount}
                total={data.total}
                currency={data.currency}
                testIdPrefix="invoice-preview"
              />
            ) : (
              <p
                className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground"
                data-testid="invoice-preview-empty"
              >
                Nothing to bill. {emptyPreviewReason(data)}
              </p>
            )}
          </>
        ) : null}
      </section>

      <Separator />

      {confirming && data && billable ? (
        <div
          className="space-y-3 rounded-lg border-2 border-destructive/50 bg-destructive/5 p-4"
          data-testid="invoice-create-confirm-panel"
        >
          <p className="flex items-start gap-2 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              This creates invoice <strong>{data.suggestedNumber}</strong> for{" "}
              <strong>{data.clientName}</strong> at{" "}
              <strong>{formatMoney(data.total, data.currency)}</strong> and bills{" "}
              {data.entryIds.length}{" "}
              {data.entryIds.length === 1 ? "entry" : "entries"}. That time
              cannot be invoiced again.
            </span>
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              data-testid="invoice-create-back"
            >
              Back to preview
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={isCreating}
              data-testid="invoice-create-confirm"
            >
              {isCreating ? <Loader2 className="size-4 animate-spin" /> : null}
              Create invoice {data.suggestedNumber}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            data-testid="invoice-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!billable || !tax.ok || isCreating}
            data-testid="invoice-create"
          >
            Create invoice…
          </Button>
        </div>
      )}
    </>
  );
}
