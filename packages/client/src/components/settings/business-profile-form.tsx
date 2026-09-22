"use client";

// The workspace's business profile: the issuer block of every invoice
// created from now on. An explicit Save rather than save-on-change like the
// rest of Settings — the profile is one statement of identity, and a half
// typed address copied onto an invoice created in another tab is worse than a
// button.
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import {
  DEFAULT_EXEMPTION_NOTES,
  IDENTITY_LIMITS,
  businessProfileProblems,
  type BusinessProfile,
  type Locale,
  type UpdateBusinessProfileInput,
} from "@starter/shared";

import { errorCode } from "@/components/catalog/types";
import {
  IDENTIFIER_INPUT_MAX,
  checkIdentifier,
  formatIbanForDisplay,
  invoiceHref,
  lineTaxToTaxChoice,
  taxChoiceToLineTax,
  type FieldErrorKey,
  type IdentifierField,
  type TaxChoice,
} from "@/components/einvoice/billing-fields";
import {
  ElectronicAddressField,
  electronicAddressDraftFrom,
  electronicAddressInput,
  type ElectronicAddressDraft,
} from "@/components/einvoice/electronic-address-field";
import { TaxChoiceSelect } from "@/components/einvoice/tax-choice-select";
import {
  DEEP_LINK_HIGHLIGHT_CLASS,
  useDeepLink,
  useDeepLinkFocus,
} from "@/components/einvoice/use-deep-link-focus";
import {
  IdentityInput,
  PostalFields,
  isCountryDraftValid,
  postalDraftFrom,
  type PostalDraft,
} from "@/components/invoices/identity-fields";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { useLocale } from "@/i18n/locale-store";
import { icuLocale } from "@/i18n/translator";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export type BusinessProfileDraft = PostalDraft &
  ElectronicAddressDraft & {
    phone: string;
    website: string;
    paymentDetails: string;
    paymentTermsDays: string;
    invoiceFooter: string;
    vatId: string;
    taxNumber: string;
    registrationNumber: string;
    sellerIdentifier: string;
    contactName: string;
    iban: string;
    bic: string;
    bankName: string;
    accountHolder: string;
    smallBusiness: boolean;
    smallBusinessNote: string;
    defaultTax: TaxChoice;
  };

export function draftFromProfile(profile: BusinessProfile): BusinessProfileDraft {
  const category = profile.defaultTaxCategory;
  return {
    ...postalDraftFrom(profile),
    ...electronicAddressDraftFrom(profile),
    phone: profile.phone ?? "",
    website: profile.website ?? "",
    paymentDetails: profile.paymentDetails ?? "",
    paymentTermsDays:
      profile.paymentTermsDays === null ? "" : String(profile.paymentTermsDays),
    invoiceFooter: profile.invoiceFooter ?? "",
    vatId: profile.vatId ?? "",
    taxNumber: profile.taxNumber ?? "",
    registrationNumber: profile.registrationNumber ?? "",
    sellerIdentifier: profile.sellerIdentifier ?? "",
    contactName: profile.contactName ?? "",
    iban: formatIbanForDisplay(profile.iban),
    bic: profile.bic ?? "",
    bankName: profile.bankName ?? "",
    accountHolder: profile.accountHolder ?? "",
    smallBusiness: profile.smallBusiness,
    smallBusinessNote: profile.smallBusinessNote ?? "",
    defaultTax:
      category === null
        ? { kind: "unset" }
        : lineTaxToTaxChoice({ category, rate: profile.defaultTaxRate ?? 0 }),
  };
}

/** Empty is "no terms"; anything else must be a whole number of days, 0–365. */
export function parseTermsDraft(value: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const days = Number(trimmed);
  return days <= 365 ? { ok: true, value: days } : { ok: false };
}

/** Why a draft cannot be saved, per input. Empty when it can. */
export type BusinessProfileDraftErrors = Partial<{
  country: true;
  paymentTermsDays: true;
  vatId: FieldErrorKey;
  iban: FieldErrorKey;
  bic: FieldErrorKey;
  electronicAddress: FieldErrorKey;
  defaultTax: "rate" | "smallBusinessNeedsE";
}>;

const IDENTIFIERS: readonly IdentifierField[] = ["vatId", "iban", "bic"];

export function draftErrors(draft: BusinessProfileDraft): BusinessProfileDraftErrors {
  const errors: BusinessProfileDraftErrors = {};
  if (!isCountryDraftValid(draft.country)) errors.country = true;
  if (!parseTermsDraft(draft.paymentTermsDays).ok) errors.paymentTermsDays = true;
  for (const field of IDENTIFIERS) {
    const check = checkIdentifier(field, draft[field]);
    if (!check.ok) errors[field] = check.errorKey;
  }
  const address = electronicAddressInput(draft);
  if (!address.ok) errors.electronicAddress = address.errorKey;
  const tax = taxChoiceToLineTax(draft.defaultTax);
  if (!tax.ok) {
    errors.defaultTax = "rate";
  } else {
    // The shared cross-field rules, on the whole row as it would be stored.
    const problems = businessProfileProblems(
      {
        smallBusiness: draft.smallBusiness,
        defaultTaxCategory: tax.tax?.category ?? null,
        defaultTaxRate: tax.tax?.rate ?? null,
      },
      false,
    );
    if (problems.some((problem) => problem.path === "defaultTaxCategory")) {
      errors.defaultTax = "smallBusinessNeedsE";
    }
  }
  return errors;
}

/**
 * The mutation payload for a draft, or null when a field would be refused.
 * Every key is sent, so Save states the whole profile as it is on screen.
 */
export function inputFromDraft(
  draft: BusinessProfileDraft,
): Omit<UpdateBusinessProfileInput, "originId"> | null {
  if (Object.keys(draftErrors(draft)).length > 0) return null;
  const terms = parseTermsDraft(draft.paymentTermsDays);
  const address = electronicAddressInput(draft);
  const tax = taxChoiceToLineTax(draft.defaultTax);
  if (!terms.ok || !address.ok || !tax.ok) return null;
  const compact = (field: IdentifierField): string | null => {
    const check = checkIdentifier(field, draft[field]);
    return check.ok ? check.value : null;
  };
  return {
    legalName: draft.legalName,
    addressLines: draft.addressLines,
    postalCode: draft.postalCode,
    city: draft.city,
    country: draft.country.trim(),
    taxId: draft.taxId,
    email: draft.email,
    phone: draft.phone,
    website: draft.website,
    paymentDetails: draft.paymentDetails,
    paymentTermsDays: terms.value,
    invoiceFooter: draft.invoiceFooter,
    vatId: compact("vatId"),
    taxNumber: draft.taxNumber,
    registrationNumber: draft.registrationNumber,
    sellerIdentifier: draft.sellerIdentifier,
    contactName: draft.contactName,
    electronicAddress: address.electronicAddress,
    electronicAddressScheme: address.electronicAddressScheme,
    iban: compact("iban"),
    bic: compact("bic"),
    bankName: draft.bankName,
    accountHolder: draft.accountHolder,
    smallBusiness: draft.smallBusiness,
    smallBusinessNote: draft.smallBusinessNote,
    defaultTaxCategory: tax.tax?.category ?? null,
    defaultTaxRate: tax.tax === null ? null : tax.tax.rate,
  };
}

/** Moves the legacy tax ID text into the field it belongs to, in the draft only. */
export function moveLegacyTaxId(
  draft: BusinessProfileDraft,
  target: "vatId" | "taxNumber",
): BusinessProfileDraft {
  if (draft.taxId.trim() === "" || draft[target].trim() !== "") return draft;
  return { ...draft, [target]: draft.taxId.trim(), taxId: "" };
}

/** Turning small business on pre-fills what it implies, and never overwrites a choice. */
export function withSmallBusiness(
  draft: BusinessProfileDraft,
  on: boolean,
  locale: Locale,
): BusinessProfileDraft {
  if (!on) return { ...draft, smallBusiness: false };
  return {
    ...draft,
    smallBusiness: true,
    smallBusinessNote:
      draft.smallBusinessNote.trim() === "" ? DEFAULT_EXEMPTION_NOTES[locale].E : draft.smallBusinessNote,
    defaultTax: draft.defaultTax.kind === "unset" ? { kind: "E" } : draft.defaultTax,
  };
}

export function BusinessProfileCard(): React.JSX.Element {
  const t = useT("settings");
  const query = trpc.settings.businessProfile.useQuery(undefined, {
    // A refusal is an answer about the role, not a blip worth retrying.
    retry: (count, error) => errorCode(error) !== "FORBIDDEN" && count < 2,
  });

  const forbidden = errorCode(query.error) === "FORBIDDEN";

  return (
    <Card data-testid="settings-business-profile">
      <CardHeader>
        <CardTitle>{t("businessProfile.title")}</CardTitle>
        <CardDescription>{t("businessProfile.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {forbidden ? (
          <div
            className="flex gap-3 rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
            data-testid="business-profile-hidden"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <p>{t("businessProfile.hiddenByRole")}</p>
          </div>
        ) : query.data ? (
          <BusinessProfileForm
            // Re-seeded when a save lands (here or in another tab), never while typing.
            key={query.data.updatedAt ?? "empty"}
            profile={query.data}
          />
        ) : query.isError ? (
          <p className="text-sm text-destructive" data-testid="business-profile-error">
            {t("businessProfile.loadFailed")}
          </p>
        ) : (
          <Loader2
            className="size-4 animate-spin text-muted-foreground"
            data-testid="business-profile-loading"
          />
        )}
      </CardContent>
    </Card>
  );
}

function BusinessProfileForm({
  profile,
}: {
  profile: BusinessProfile;
}): React.JSX.Element {
  const t = useT("settings");
  const te = useT("einvoice");
  const tErrors = (key: FieldErrorKey): string => te(`errors.${key}`);
  const locale = icuLocale(useLocale());
  const utils = trpc.useUtils();
  const [draft, setDraft] = React.useState(() => draftFromProfile(profile));
  // Decided by the SAVED value, never by the draft: clearing the input to
  // retype it must not unmount it. Only a move into a structured field hides it.
  const [showLegacyTaxId, setShowLegacyTaxId] = React.useState(
    () => (profile.taxId ?? "").trim() !== "",
  );
  const errors = draftErrors(draft);
  const payload = inputFromDraft(draft);
  const formRef = React.useRef<HTMLFormElement>(null);
  const link = useDeepLink();
  useDeepLinkFocus(formRef, true, link.field);

  const update = trpc.settings.updateBusinessProfile.useMutation({
    onSuccess: (saved) => {
      utils.settings.businessProfile.setData(undefined, saved);
      toast.success(t("businessProfile.saved"));
    },
    onError: (error) => {
      toast.error(
        errorCode(error) === "FORBIDDEN"
          ? t("businessProfile.forbidden")
          : t("businessProfile.saveFailed"),
      );
    },
  });

  const set = <K extends keyof BusinessProfileDraft>(
    key: K,
    value: BusinessProfileDraft[K],
  ): void => setDraft((current) => ({ ...current, [key]: value }));

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!payload) return;
    update.mutate({ ...payload, originId: ORIGIN_ID });
  };

  const text = (
    key: "taxNumber" | "registrationNumber" | "sellerIdentifier" | "contactName" | "bankName" | "accountHolder",
    hint?: string,
  ): React.JSX.Element => (
    <IdentityInput
      prefix="business-profile"
      fieldKey={key}
      label={t(`businessProfile.${key}`)}
      value={draft[key]}
      maxLength={IDENTITY_LIMITS[key]}
      onChange={(value) => set(key, value)}
      hint={hint}
    />
  );

  const identifier = (key: IdentifierField, hint?: string): React.JSX.Element => (
    <IdentityInput
      prefix="business-profile"
      fieldKey={key}
      label={t(`businessProfile.${key}`)}
      value={draft[key]}
      maxLength={IDENTIFIER_INPUT_MAX[key]}
      autoCapitalize="characters"
      spellCheck={false}
      onChange={(value) => set(key, value)}
      hint={hint}
      error={errors[key] ? tErrors(errors[key]) : null}
    />
  );

  const section = (title: string): React.JSX.Element => (
    <h3 className="pt-2 text-sm font-semibold">{title}</h3>
  );

  return (
    <form
      ref={formRef}
      className="space-y-4"
      onSubmit={onSubmit}
      data-testid="business-profile-form"
    >
      {link.fromInvoiceId ? (
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link href={invoiceHref(link.fromInvoiceId)} data-testid="business-profile-back-to-invoice">
            <ArrowLeft className="size-4" />
            {t("businessProfile.backToInvoice")}
          </Link>
        </Button>
      ) : null}

      <PostalFields
        prefix="business-profile"
        draft={draft}
        showTaxId={false}
        onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
        labels={{
          legalName: t("businessProfile.legalName"),
          addressLine: (line) => t("businessProfile.addressLine", { line: String(line) }),
          postalCode: t("businessProfile.postalCode"),
          city: t("businessProfile.city"),
          country: t("businessProfile.country"),
          taxId: t("businessProfile.taxId"),
          email: t("businessProfile.email"),
          invalidCountry: t("businessProfile.invalidCountry"),
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <IdentityInput
          prefix="business-profile"
          fieldKey="phone"
          label={t("businessProfile.phone")}
          type="tel"
          maxLength={IDENTITY_LIMITS.phone}
          value={draft.phone}
          onChange={(value) => set("phone", value)}
        />
        <IdentityInput
          prefix="business-profile"
          fieldKey="website"
          label={t("businessProfile.website")}
          maxLength={IDENTITY_LIMITS.website}
          value={draft.website}
          onChange={(value) => set("website", value)}
        />
      </div>

      {section(t("businessProfile.sections.taxIdentity"))}
      <div className="grid gap-3 sm:grid-cols-2">
        {identifier("vatId", t("businessProfile.vatIdHint"))}
        {text("taxNumber", t("businessProfile.taxNumberHint"))}
        {showLegacyTaxId ? (
          <div
            className={cn(
              "space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 sm:col-span-2",
              DEEP_LINK_HIGHLIGHT_CLASS,
            )}
            data-field="taxId"
            data-testid="business-profile-legacy-taxid"
          >
            <Label htmlFor="business-profile-taxId">{t("businessProfile.legacyTaxId")}</Label>
            <Input
              id="business-profile-taxId"
              maxLength={IDENTITY_LIMITS.taxId}
              value={draft.taxId}
              onChange={(event) => set("taxId", event.target.value)}
              data-testid="business-profile-taxId"
            />
            <p className="text-xs text-muted-foreground">{t("businessProfile.legacyTaxIdHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={draft.vatId.trim() !== ""}
                onClick={() => {
                  setDraft((current) => moveLegacyTaxId(current, "vatId"));
                  setShowLegacyTaxId(false);
                }}
                data-testid="business-profile-taxid-use-vat"
              >
                {t("businessProfile.useAsVatId")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={draft.taxNumber.trim() !== ""}
                onClick={() => {
                  setDraft((current) => moveLegacyTaxId(current, "taxNumber"));
                  setShowLegacyTaxId(false);
                }}
                data-testid="business-profile-taxid-use-number"
              >
                {t("businessProfile.useAsTaxNumber")}
              </Button>
            </div>
          </div>
        ) : null}
        {text("registrationNumber", t("businessProfile.registrationNumberHint"))}
        {text("sellerIdentifier", t("businessProfile.sellerIdentifierHint"))}
      </div>

      {section(t("businessProfile.sections.contact"))}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("contactName", t("businessProfile.contactNameHint"))}
      </div>

      {section(t("businessProfile.sections.einvoiceAddress"))}
      <ElectronicAddressField
        prefix="business-profile"
        value={draft}
        onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
        emailPlaceholder={draft.email}
        hint={t("businessProfile.electronicAddressHint")}
      />

      {section(t("businessProfile.sections.bank"))}
      <p className="text-xs text-muted-foreground">{t("businessProfile.bankHint")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">{identifier("iban")}</div>
        {identifier("bic")}
        {text("bankName")}
        <div className="sm:col-span-2">{text("accountHolder")}</div>
      </div>

      <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="paymentDetails">
        <Label htmlFor="business-profile-payment-details">
          {t("businessProfile.paymentDetails")}
        </Label>
        <Textarea
          id="business-profile-payment-details"
          rows={3}
          maxLength={IDENTITY_LIMITS.paymentDetails}
          value={draft.paymentDetails}
          onChange={(event) => set("paymentDetails", event.target.value)}
          data-testid="business-profile-payment-details"
        />
        <p className="text-xs text-muted-foreground">
          {t("businessProfile.paymentDetailsHint")}
        </p>
      </div>

      <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="paymentTermsDays">
        <Label htmlFor="business-profile-terms">
          {t("businessProfile.paymentTermsDays")}
        </Label>
        <NumberInput
          id="business-profile-terms"
          className="sm:w-32"
          value={draft.paymentTermsDays}
          min={0}
          precision={0}
          aria-invalid={errors.paymentTermsDays === true}
          onValueChange={(next) => set("paymentTermsDays", next)}
          data-testid="business-profile-terms"
        />
        {errors.paymentTermsDays ? (
          <p className="text-sm text-destructive" data-testid="business-profile-terms-error">
            {t("businessProfile.invalidTerms")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("businessProfile.paymentTermsHint")}
          </p>
        )}
      </div>

      {section(t("businessProfile.sections.vat"))}
      <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="smallBusiness">
        <div className="flex items-center gap-2">
          <Checkbox
            id="business-profile-smallBusiness"
            checked={draft.smallBusiness}
            onCheckedChange={(checked) =>
              setDraft((current) => withSmallBusiness(current, checked === true, locale))
            }
            data-testid="business-profile-smallBusiness"
          />
          <Label htmlFor="business-profile-smallBusiness">{t("businessProfile.smallBusiness")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("businessProfile.smallBusinessHint")}</p>
      </div>
      {draft.smallBusiness ? (
        <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="smallBusinessNote">
          <Label htmlFor="business-profile-smallBusinessNote">
            {t("businessProfile.smallBusinessNote")}
          </Label>
          <Textarea
            id="business-profile-smallBusinessNote"
            rows={2}
            maxLength={IDENTITY_LIMITS.smallBusinessNote}
            value={draft.smallBusinessNote}
            onChange={(event) => set("smallBusinessNote", event.target.value)}
            data-testid="business-profile-smallBusinessNote"
          />
          <p className="text-xs text-muted-foreground">
            {t("businessProfile.smallBusinessNoteHint")}
          </p>
        </div>
      ) : null}
      <div className={cn("space-y-1.5", DEEP_LINK_HIGHLIGHT_CLASS)} data-field="defaultTaxCategory">
        <Label htmlFor="business-profile-defaultTaxCategory">{t("businessProfile.defaultTax")}</Label>
        <TaxChoiceSelect
          id="business-profile-defaultTaxCategory"
          value={draft.defaultTax}
          onChange={(next) => set("defaultTax", next)}
          testId="business-profile-defaultTaxCategory"
        />
        {errors.defaultTax === "smallBusinessNeedsE" ? (
          <p className="text-sm text-destructive" data-testid="business-profile-defaultTaxCategory-error">
            {t("businessProfile.smallBusinessNeedsE")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("businessProfile.defaultTaxHint")}</p>
        )}
      </div>

      <IdentityInput
        prefix="business-profile"
        fieldKey="invoiceFooter"
        label={t("businessProfile.invoiceFooter")}
        maxLength={IDENTITY_LIMITS.invoiceFooter}
        value={draft.invoiceFooter}
        onChange={(value) => set("invoiceFooter", value)}
        data-testid="business-profile-footer"
      />

      <div className="flex flex-wrap items-center justify-end gap-3">
        {payload === null ? (
          <p className="text-sm text-muted-foreground" data-testid="business-profile-invalid">
            {t("businessProfile.invalidFields")}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={payload === null || update.isPending}
          data-testid="business-profile-save"
        >
          {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("businessProfile.save")}
        </Button>
      </div>
    </form>
  );
}
