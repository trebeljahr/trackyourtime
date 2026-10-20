"use client";

import * as React from "react";
import { X } from "lucide-react";

import { ProjectDonateLink } from "@/components/marketing/project-donate-link";
import { Button } from "@/components/ui/button";
import { useIsTokenShell } from "@/hooks/use-shell";
import { useT } from "@/i18n/use-t";
import { DONATION_SUPPORTED_AT_KEY } from "@/lib/donation-return";
import { isTokenShell } from "@/lib/shell";
import { DONATE_URL } from "@/lib/site-links";

/** Set the first time the card is shown; it is never shown again in this browser. */
export const INVOICE_SUPPORT_CARD_KEY = "trackyourtime.invoice-support-card";

/**
 * Whether this PDF download is the one that shows the support card, and if
 * so, records that it was shown.
 *
 * Web browsers only. The iOS and Android apps may not link to a payment
 * (App Store guideline 3.1.1, Google Play's payments policy), and the desktop
 * app ships through the Mac App Store too, so every shell is left out.
 *
 * The mark is written before the card appears, so the card shows once even
 * when it is never closed. Someone who came back from the donate page
 * (`donation-supported-at`) has already given, so the card is used up without
 * showing. Storage that throws shows nothing: a card that cannot remember
 * being shown would come back on every download.
 */
export function claimInvoiceSupportCard(
  storage: Pick<Storage, "getItem" | "setItem"> | null = browserStorage(),
): boolean {
  if (isTokenShell() || storage === null) return false;
  try {
    if (storage.getItem(INVOICE_SUPPORT_CARD_KEY) !== null) return false;
    storage.setItem(INVOICE_SUPPORT_CARD_KEY, "shown");
    return storage.getItem(DONATION_SUPPORTED_AT_KEY) === null;
  } catch {
    return false;
  }
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A small note under the invoice actions after the first invoice PDF, with a
 * link to the donate page. Part of the page, never a dialog.
 */
export function InvoiceSupportCard({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element | null {
  const t = useT("reports");
  if (useIsTokenShell()) return null;
  return (
    <aside
      className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
      data-testid="invoice-support-card"
    >
      <span aria-hidden="true" className="text-lg leading-none">
        🍪
      </span>
      <p className="min-w-0 flex-1 self-center text-muted-foreground">
        {t.rich("invoices.supportCard.body", {
          donate: (chunks) => (
            <ProjectDonateLink
              href={DONATE_URL}
              className="text-foreground underline underline-offset-4"
              data-testid="invoice-support-card-donate"
            >
              {chunks}
            </ProjectDonateLink>
          ),
        })}
      </p>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        aria-label={t("invoices.supportCard.close")}
        onClick={onClose}
        data-testid="invoice-support-card-close"
      >
        <X className="size-4" />
      </Button>
    </aside>
  );
}
