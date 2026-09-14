"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  isLocale,
  SUPPORTED_LOCALES,
  type ClientBillingInput,
  type Locale,
} from "@starter/shared";

import { ColorPicker, COLOR_PALETTE } from "@/components/color-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import {
  PostalFields,
  isCountryDraftValid,
  postalDraftFrom,
  type PostalDraft,
} from "@/components/invoices/identity-fields";
import { translate, useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { useClientMutations } from "./use-catalog-mutations";
import type { ClientRow } from "./types";

export type ClientFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omitted/null creates; otherwise the dialog edits this client. */
  client?: ClientRow | null;
};

const FALLBACK_COLOR = COLOR_PALETTE[0] ?? "#4f46e5";

type BillingDraft = PostalDraft & { reference: string };

const billingDraftFrom = (client: ClientRow | null): BillingDraft => ({
  ...postalDraftFrom(client?.billing),
  reference: client?.billing?.reference ?? "",
});

/**
 * The billing payload to send. Sent whole on every save — the server stores
 * an all-blank one as "no billing details", so clearing every field clears
 * them rather than leaving yesterday's address behind.
 */
export function billingInputFromDraft(draft: BillingDraft): ClientBillingInput {
  return {
    legalName: draft.legalName,
    addressLines: draft.addressLines,
    postalCode: draft.postalCode,
    city: draft.city,
    country: draft.country.trim(),
    taxId: draft.taxId,
    email: draft.email,
    reference: draft.reference,
  };
}

export function ClientFormDialog({
  open,
  onOpenChange,
  client,
}: ClientFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        data-testid="client-dialog"
      >
        {open ? (
          <ClientForm
            key={client?.id ?? "new"}
            client={client ?? null}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ClientFormProps = {
  client: ClientRow | null;
  onDone: () => void;
};

function ClientForm({ client, onDone }: ClientFormProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const [name, setName] = React.useState(client?.name ?? "");
  const [color, setColor] = React.useState(client?.color ?? FALLBACK_COLOR);
  // "" is "no preference": the invoice follows the issuer's own language.
  const [invoiceLocale, setInvoiceLocale] = React.useState<Locale | "">(
    client?.invoiceLocale ?? "",
  );
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [billing, setBilling] = React.useState(() => billingDraftFrom(client));
  // Open when there is something to see, so an edit never hides stored details.
  const [billingOpen, setBillingOpen] = React.useState(
    () => (client?.billing ?? null) !== null,
  );
  const billingValid = isCountryDraftValid(billing.country);

  const { createClient, updateClient, isSaving } = useClientMutations({
    onConflict: setNameError,
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setNameError(null);

    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError(t("form.nameRequired"));
      return;
    }
    if (!billingValid) {
      setBillingOpen(true);
      return;
    }
    // Only a change is sent, so saving a renamed client never writes an empty
    // billing subdocument onto a row that has none.
    const billingInput = billingInputFromDraft(billing);
    const billingChanged =
      JSON.stringify(billingInput) !==
      JSON.stringify(billingInputFromDraft(billingDraftFrom(client)));
    const billingPatch = billingChanged ? { billing: billingInput } : {};

    // Sent as null, not omitted, so clearing the choice reaches the server.
    const locale = invoiceLocale === "" ? null : invoiceLocale;

    if (client) {
      void updateClient({
        id: client.id,
        name: trimmed,
        color,
        invoiceLocale: locale,
        ...billingPatch,
      }).then((saved) => {
        if (!saved) return;
        toast.success(translate("catalog")("clients.form.saved"));
        onDone();
      });
      return;
    }

    void createClient({ name: trimmed, color, invoiceLocale: locale, ...billingPatch }).then(
      (created) => {
        if (!created) return;
        toast.success(
          translate("catalog")("clients.form.created", { name: created.name }),
        );
        onDone();
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {client ? t("clients.form.titleEdit") : t("clients.form.titleNew")}
        </DialogTitle>
        <DialogDescription>{t("clients.form.description")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="client-name">{tc("fields.name")}</Label>
        <div className="flex items-center gap-2">
          <ColorPicker value={color} onChange={setColor} testId="client-color" />
          <Input
            id="client-name"
            value={name}
            autoFocus
            maxLength={120}
            placeholder={t("clients.form.namePlaceholder")}
            aria-invalid={nameError !== null}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(null);
            }}
            data-testid="client-name-input"
          />
        </div>
        {nameError ? (
          <p className="text-sm text-destructive" data-testid="client-name-error">
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="client-invoice-locale">
          {t("clients.form.invoiceLocale.label")}
        </Label>
        <select
          id="client-invoice-locale"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={invoiceLocale}
          onChange={(event) => {
            const next = event.target.value;
            setInvoiceLocale(isLocale(next) ? next : "");
          }}
          data-testid="client-invoice-locale"
        >
          <option value="">{t("clients.form.invoiceLocale.inherit")}</option>
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale} lang={locale}>
              {t(`clients.form.invoiceLocale.${locale}`)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t("clients.form.invoiceLocale.hint")}
        </p>
      </div>

      <section className="space-y-3" data-testid="client-billing">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={billingOpen}
          aria-controls="client-billing-fields"
          onClick={() => setBillingOpen((open) => !open)}
          data-testid="client-billing-toggle"
        >
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">{t("clientBilling.toggle")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("clientBilling.toggleHint")}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              billingOpen && "rotate-180",
            )}
          />
        </button>
        {billingOpen ? (
          <div id="client-billing-fields" className="space-y-3">
            <PostalFields
              prefix="client-billing"
              draft={billing}
              onChange={(next) => setBilling((current) => ({ ...current, ...next }))}
              labels={{
                legalName: t("clientBilling.legalName"),
                addressLine: (line) =>
                  t("clientBilling.addressLine", { line: String(line) }),
                postalCode: t("clientBilling.postalCode"),
                city: t("clientBilling.city"),
                country: t("clientBilling.country"),
                taxId: t("clientBilling.taxId"),
                email: t("clientBilling.email"),
                invalidCountry: t("clientBilling.invalidCountry"),
              }}
            />
            <div className="space-y-1.5">
              <Label htmlFor="client-billing-reference">
                {t("clientBilling.reference")}
              </Label>
              <Input
                id="client-billing-reference"
                maxLength={120}
                value={billing.reference}
                onChange={(event) =>
                  setBilling((current) => ({ ...current, reference: event.target.value }))
                }
                data-testid="client-billing-reference"
              />
              <p className="text-xs text-muted-foreground">
                {t("clientBilling.referenceHint")}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          data-testid="client-cancel"
        >
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" disabled={isSaving} data-testid="client-submit">
          {client ? t("form.saveChanges") : t("clients.form.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
