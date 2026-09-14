"use client";

// The workspace's business profile: the issuer block of every invoice
// created from now on. An explicit Save rather than save-on-change like the
// rest of Settings — the profile is one statement of identity, and a half
// typed address copied onto an invoice created in another tab is worse than a
// button.
import * as React from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import type { BusinessProfile, UpdateBusinessProfileInput } from "@starter/shared";

import { errorCode } from "@/components/catalog/types";
import {
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

export type BusinessProfileDraft = PostalDraft & {
  phone: string;
  website: string;
  paymentDetails: string;
  paymentTermsDays: string;
  invoiceFooter: string;
};

export function draftFromProfile(profile: BusinessProfile): BusinessProfileDraft {
  return {
    ...postalDraftFrom(profile),
    phone: profile.phone ?? "",
    website: profile.website ?? "",
    paymentDetails: profile.paymentDetails ?? "",
    paymentTermsDays:
      profile.paymentTermsDays === null ? "" : String(profile.paymentTermsDays),
    invoiceFooter: profile.invoiceFooter ?? "",
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

/** The mutation payload for a draft, or null when a field would be refused. */
export function inputFromDraft(
  draft: BusinessProfileDraft,
): Omit<UpdateBusinessProfileInput, "originId"> | null {
  const terms = parseTermsDraft(draft.paymentTermsDays);
  if (!terms.ok || !isCountryDraftValid(draft.country)) return null;
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
  const utils = trpc.useUtils();
  const [draft, setDraft] = React.useState(() => draftFromProfile(profile));
  const terms = parseTermsDraft(draft.paymentTermsDays);
  const payload = inputFromDraft(draft);

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

  return (
    <form className="space-y-4" onSubmit={onSubmit} data-testid="business-profile-form">
      <PostalFields
        prefix="business-profile"
        draft={draft}
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
        <div className="space-y-1.5">
          <Label htmlFor="business-profile-phone">{t("businessProfile.phone")}</Label>
          <Input
            id="business-profile-phone"
            type="tel"
            maxLength={40}
            value={draft.phone}
            onChange={(event) => set("phone", event.target.value)}
            data-testid="business-profile-phone"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="business-profile-website">{t("businessProfile.website")}</Label>
          <Input
            id="business-profile-website"
            maxLength={200}
            value={draft.website}
            onChange={(event) => set("website", event.target.value)}
            data-testid="business-profile-website"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="business-profile-payment-details">
          {t("businessProfile.paymentDetails")}
        </Label>
        <Textarea
          id="business-profile-payment-details"
          rows={3}
          maxLength={1_000}
          value={draft.paymentDetails}
          onChange={(event) => set("paymentDetails", event.target.value)}
          data-testid="business-profile-payment-details"
        />
        <p className="text-xs text-muted-foreground">
          {t("businessProfile.paymentDetailsHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="business-profile-terms">
          {t("businessProfile.paymentTermsDays")}
        </Label>
        <Input
          id="business-profile-terms"
          inputMode="numeric"
          className="sm:w-32"
          value={draft.paymentTermsDays}
          aria-invalid={!terms.ok}
          onChange={(event) => set("paymentTermsDays", event.target.value)}
          data-testid="business-profile-terms"
        />
        {terms.ok ? (
          <p className="text-xs text-muted-foreground">
            {t("businessProfile.paymentTermsHint")}
          </p>
        ) : (
          <p className="text-sm text-destructive" data-testid="business-profile-terms-error">
            {t("businessProfile.invalidTerms")}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="business-profile-footer">{t("businessProfile.invoiceFooter")}</Label>
        <Input
          id="business-profile-footer"
          maxLength={500}
          value={draft.invoiceFooter}
          onChange={(event) => set("invoiceFooter", event.target.value)}
          data-testid="business-profile-footer"
        />
      </div>

      <div className="flex justify-end">
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
