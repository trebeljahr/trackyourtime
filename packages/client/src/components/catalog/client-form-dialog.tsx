"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown } from "lucide-react";
import {
  INVOICE_FORMATS,
  isLocale,
  SUPPORTED_LOCALES,
  type ClientBillingInput,
  type InvoiceFormat,
  type Locale,
  type TaxCategory,
} from "@starter/shared";

import { ColorPicker, COLOR_PALETTE } from "@/components/color-picker";
import {
  IDENTIFIER_INPUT_MAX,
  checkIdentifier,
  invoiceHref,
  suggestClientTaxCategory,
} from "@/components/einvoice/billing-fields";
import {
  ElectronicAddressField,
  electronicAddressDraftFrom,
  electronicAddressInput,
  type ElectronicAddressDraft,
} from "@/components/einvoice/electronic-address-field";
import { NativeSelect } from "@/components/einvoice/native-select";
import { TaxCategorySelect } from "@/components/einvoice/tax-choice-select";
import {
  DEEP_LINK_HIGHLIGHT_CLASS,
  useDeepLinkFocus,
} from "@/components/einvoice/use-deep-link-focus";
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
  IdentityInput,
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
  /**
   * An e-invoice deep link: open with the billing details expanded and this
   * input (main's model key, e.g. "reference") focused.
   */
  focusBillingField?: string | null;
  /** The invoice the deep link came from, for a way back. */
  fromInvoiceId?: string | null;
  /** The issuer's country, for the default VAT category suggestion. */
  issuerCountry?: string | null;
};

const FALLBACK_COLOR = COLOR_PALETTE[0] ?? "#4f46e5";

export type BillingDraft = PostalDraft &
  ElectronicAddressDraft & {
    reference: string;
    vatId: string;
    preferredFormat: InvoiceFormat | null;
    defaultTaxCategory: TaxCategory | null;
  };

export const billingDraftFrom = (client: ClientRow | null): BillingDraft => ({
  ...postalDraftFrom(client?.billing),
  ...electronicAddressDraftFrom({
    electronicAddress: client?.billing?.electronicAddress ?? null,
    electronicAddressScheme: client?.billing?.electronicAddressScheme ?? null,
  }),
  reference: client?.billing?.reference ?? "",
  vatId: client?.billing?.vatId ?? "",
  preferredFormat: client?.billing?.preferredFormat ?? null,
  defaultTaxCategory: client?.billing?.defaultTaxCategory ?? null,
});

/** Whether every billing input holds something the server accepts. */
export function billingDraftValid(draft: BillingDraft): boolean {
  return (
    isCountryDraftValid(draft.country) &&
    checkIdentifier("vatId", draft.vatId).ok &&
    electronicAddressInput(draft).ok
  );
}

/**
 * The billing payload to send. Sent whole on every save — the server stores
 * an all-blank one as "no billing details", so clearing every field clears
 * them rather than leaving yesterday's address behind. Call it on a valid
 * draft; an invalid identifier is sent as typed and refused by the server.
 */
export function billingInputFromDraft(draft: BillingDraft): ClientBillingInput {
  const vatId = checkIdentifier("vatId", draft.vatId);
  const address = electronicAddressInput(draft);
  return {
    legalName: draft.legalName,
    addressLines: draft.addressLines,
    postalCode: draft.postalCode,
    city: draft.city,
    country: draft.country.trim(),
    taxId: draft.taxId,
    email: draft.email,
    reference: draft.reference,
    vatId: vatId.ok ? vatId.value : draft.vatId,
    electronicAddress: address.ok ? address.electronicAddress : draft.electronicAddress,
    electronicAddressScheme: address.ok ? address.electronicAddressScheme : draft.electronicAddressScheme,
    preferredFormat: draft.preferredFormat,
    defaultTaxCategory: draft.defaultTaxCategory,
  };
}

export function ClientFormDialog({
  open,
  onOpenChange,
  client,
  focusBillingField = null,
  fromInvoiceId = null,
  issuerCountry = null,
}: ClientFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        data-testid="client-dialog"
        onOpenAutoFocus={(event) => {
          // Opened over another dialog (the invoice's "Add the VAT ID"), the
          // form's own deep-link focus runs before this dialog's focus scope
          // is active, so the outer dialog's trap takes the focus back. This
          // event fires once the scope is active, so focusing here sticks.
          if (focusBillingField === null || !(event.target instanceof HTMLElement)) return;
          const control = event.target.querySelector<HTMLElement>(
            `[data-field="${focusBillingField}"] :is(input, textarea, select, button)`,
          );
          if (control === null) return;
          event.preventDefault();
          control.focus({ preventScroll: true });
        }}
      >
        {open ? (
          <ClientForm
            key={client?.id ?? "new"}
            client={client ?? null}
            focusBillingField={focusBillingField}
            fromInvoiceId={fromInvoiceId}
            issuerCountry={issuerCountry}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ClientFormProps = {
  client: ClientRow | null;
  focusBillingField: string | null;
  fromInvoiceId: string | null;
  issuerCountry: string | null;
  onDone: () => void;
};

function ClientForm({
  client,
  focusBillingField,
  fromInvoiceId,
  issuerCountry,
  onDone,
}: ClientFormProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const te = useT("einvoice");
  const [name, setName] = React.useState(client?.name ?? "");
  const [color, setColor] = React.useState(client?.color ?? FALLBACK_COLOR);
  // "" is "no preference": the invoice follows the issuer's own language.
  const [invoiceLocale, setInvoiceLocale] = React.useState<Locale | "">(
    client?.invoiceLocale ?? "",
  );
  const [nameError, setNameError] = React.useState<string | null>(null);

  const [billing, setBilling] = React.useState(() => billingDraftFrom(client));
  // Decided by the SAVED value, never by the draft: clearing the input to
  // retype it must not unmount it. Only the move into the VAT ID hides it.
  const [showLegacyTaxId, setShowLegacyTaxId] = React.useState(
    () => (client?.billing?.taxId ?? "").trim() !== "",
  );
  // Open when there is something to see, so an edit never hides stored
  // details — or when a deep link came to fix one of them.
  const [billingOpen, setBillingOpen] = React.useState(
    () => (client?.billing ?? null) !== null || focusBillingField !== null,
  );
  const billingValid = billingDraftValid(billing);
  const vatIdCheck = checkIdentifier("vatId", billing.vatId);
  const billingRef = React.useRef<HTMLDivElement>(null);
  useDeepLinkFocus(billingRef, billingOpen, focusBillingField);

  const suggestion = suggestClientTaxCategory(
    issuerCountry,
    billing.country.trim() === "" ? null : billing.country.trim(),
    vatIdCheck.ok && vatIdCheck.value !== null,
  );

  const { createClient, updateClient, isSaving } = useClientMutations({
    onConflict: setNameError,
  });

  const setBillingKey = <K extends keyof BillingDraft>(key: K, value: BillingDraft[K]): void =>
    setBilling((current) => ({ ...current, [key]: value }));

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

      {fromInvoiceId ? (
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link href={invoiceHref(fromInvoiceId)} data-testid="client-billing-back-to-invoice">
            <ArrowLeft className="size-4" />
            {t("clientBilling.backToInvoice")}
          </Link>
        </Button>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="client-name">{tc("fields.name")}</Label>
        <div className="flex items-center gap-2">
          <ColorPicker value={color} onChange={setColor} testId="client-color" />
          <Input
            id="client-name"
            value={name}
            // A deep link focuses a billing input instead.
            autoFocus={focusBillingField === null}
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
          <div id="client-billing-fields" className="space-y-3" ref={billingRef}>
            <PostalFields
              prefix="client-billing"
              draft={billing}
              showTaxId={false}
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
            <IdentityInput
              prefix="client-billing"
              fieldKey="vatId"
              label={t("clientBilling.vatId")}
              value={billing.vatId}
              maxLength={IDENTIFIER_INPUT_MAX.vatId}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(value) => setBillingKey("vatId", value)}
              hint={t("clientBilling.vatIdHint")}
              error={vatIdCheck.ok ? null : te(`errors.${vatIdCheck.errorKey}`)}
            />
            {showLegacyTaxId ? (
              <div
                className={cn(
                  "space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3",
                  DEEP_LINK_HIGHLIGHT_CLASS,
                )}
                data-field="taxId"
                data-testid="client-billing-legacy-taxid"
              >
                <Label htmlFor="client-billing-taxId">{t("clientBilling.legacyTaxId")}</Label>
                <Input
                  id="client-billing-taxId"
                  maxLength={60}
                  value={billing.taxId}
                  onChange={(event) => setBillingKey("taxId", event.target.value)}
                  data-testid="client-billing-taxId"
                />
                <p className="text-xs text-muted-foreground">{t("clientBilling.legacyTaxIdHint")}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={billing.vatId.trim() !== ""}
                  onClick={() => {
                    setBilling((current) =>
                      current.vatId.trim() === ""
                        ? { ...current, vatId: current.taxId.trim(), taxId: "" }
                        : current,
                    );
                    setShowLegacyTaxId(false);
                  }}
                  data-testid="client-billing-taxid-use-vat"
                >
                  {t("clientBilling.useAsVatId")}
                </Button>
              </div>
            ) : null}
            <IdentityInput
              prefix="client-billing"
              fieldKey="reference"
              label={t("clientBilling.reference")}
              maxLength={120}
              value={billing.reference}
              onChange={(value) => setBillingKey("reference", value)}
              hint={t("clientBilling.referenceHint")}
            />
            <ElectronicAddressField
              prefix="client-billing"
              value={billing}
              onChange={(next) => setBilling((current) => ({ ...current, ...next }))}
              emailPlaceholder={billing.email}
              hint={t("clientBilling.electronicAddressHint")}
            />
            <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="preferredFormat">
              <Label htmlFor="client-billing-preferredFormat">{t("clientBilling.preferredFormat")}</Label>
              <NativeSelect
                id="client-billing-preferredFormat"
                value={billing.preferredFormat ?? "pdf"}
                onChange={(event) => {
                  const next = event.target.value as InvoiceFormat;
                  // "pdf" is the default a null already states.
                  setBillingKey("preferredFormat", next === "pdf" ? null : next);
                }}
                data-testid="client-billing-preferredFormat"
              >
                {INVOICE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {te(`formats.${format}`)}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">{t("clientBilling.preferredFormatHint")}</p>
            </div>
            <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="defaultTaxCategory">
              <Label htmlFor="client-billing-defaultTaxCategory">{t("clientBilling.defaultTax")}</Label>
              <TaxCategorySelect
                id="client-billing-defaultTaxCategory"
                value={billing.defaultTaxCategory}
                onChange={(next) => setBillingKey("defaultTaxCategory", next)}
                testId="client-billing-defaultTaxCategory"
              />
              {suggestion !== null && billing.defaultTaxCategory !== suggestion ? (
                <p
                  className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  data-testid="client-billing-tax-suggestion"
                >
                  {t("clientBilling.suggestion", { category: te(`tax.choice.${suggestion}`) })}
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    className="h-auto px-0 text-xs"
                    onClick={() => setBillingKey("defaultTaxCategory", suggestion)}
                    data-testid="client-billing-tax-suggestion-use"
                  >
                    {t("clientBilling.useSuggestion")}
                  </Button>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("clientBilling.defaultTaxHint")}</p>
              )}
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
