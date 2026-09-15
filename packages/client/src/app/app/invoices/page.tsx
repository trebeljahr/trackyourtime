"use client";

import * as React from "react";

import { InvoicesScreen } from "@/components/invoices/invoices-screen";
import { useT } from "@/i18n/use-t";

export default function InvoicesPage(): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  return (
    <div className="space-y-6" data-testid="invoices-page">
      <header>
        <h1 className="text-2xl font-bold">{tc("fields.invoices")}</h1>
        <p className="text-sm text-muted-foreground">{t("invoices.description")}</p>
      </header>
      <InvoicesScreen />
    </div>
  );
}
