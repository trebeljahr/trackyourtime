"use client";

// Before an invoice is created, say which party it will not be able to name.
//
// The invoice freezes both parties at creation, so this dialog is the last
// moment an empty address is cheap to fix: afterwards the document carries the
// gap for good. Each warning links to the one screen that fills it.
import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  isPostalAddressMissing,
  type BusinessProfile,
  type Client,
} from "@starter/shared";

import { useT } from "@/i18n/use-t";

export type InvoiceIdentityWarningsProps = {
  /**
   * The workspace profile, `undefined` while loading or when this person's
   * role may not read it — neither is a reason to warn.
   */
  profile: BusinessProfile | undefined;
  /** The chosen client, `null` before one is picked. */
  client: Client | null;
};

export function InvoiceIdentityWarnings({
  profile,
  client,
}: InvoiceIdentityWarningsProps): React.JSX.Element | null {
  const t = useT("reports");
  const profileMissing = profile !== undefined && isPostalAddressMissing(profile);
  const clientMissing = client !== null && isPostalAddressMissing(client.billing);
  if (!profileMissing && !clientMissing) return null;

  return (
    <div className="space-y-2" data-testid="invoice-identity-warnings">
      {profileMissing ? (
        <Warning testId="invoice-warning-profile">
          {t("invoiceIdentity.profileMissing")}{" "}
          <Link
            href="/app/settings?tab=billing"
            className="font-medium underline underline-offset-2"
            data-testid="invoice-warning-profile-link"
          >
            {t("invoiceIdentity.profileLink")}
          </Link>
        </Warning>
      ) : null}
      {clientMissing && client ? (
        <Warning testId="invoice-warning-client">
          {t("invoiceIdentity.clientMissing", { client: client.name })}{" "}
          <Link
            href="/app/clients"
            className="font-medium underline underline-offset-2"
            data-testid="invoice-warning-client-link"
          >
            {t("invoiceIdentity.clientLink")}
          </Link>
        </Warning>
      ) : null}
    </div>
  );
}

function Warning({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId: string;
}): React.JSX.Element {
  return (
    <p
      className="flex items-start gap-2 rounded-md border border-amber-500/40 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
      data-testid={testId}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
