"use client";

import { useClientOptions, useProjectOptions } from "@/hooks/use-catalog-options";

import * as React from "react";

import { CatalogScreen } from "@/components/catalog/catalog-screen";
import { ClientFormDialog } from "@/components/catalog/client-form-dialog";
import { ClientsTable } from "@/components/catalog/clients-table";
import { useDeepLink } from "@/components/einvoice/use-deep-link-focus";
import {
  CLIENT_LIST_INPUT,
  PROJECT_LIST_INPUT,
  type ClientRow,
  type ProjectTableRow,
} from "@/components/catalog/types";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

export default function ClientsPage(): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const [search, setSearch] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  // `?billing=<clientId>&field=<key>&from=invoice:<id>`: an e-invoice issue
  // sent the person here to fix one billing detail of one client.
  const link = useDeepLink();
  const [linkDismissed, setLinkDismissed] = React.useState(false);

  const metadata = useClientOptions(CLIENT_LIST_INPUT);
  const clientsQuery = trpc.clients.list.useQuery(CLIENT_LIST_INPUT, {
    staleTime: 30_000,
  });
  // The roll-ups on each client row are derived from the project list.
  const projectsQuery = useProjectOptions(PROJECT_LIST_INPUT, {
    staleTime: 30_000,
  });

  // For the default VAT category suggestion. A role that may not read the
  // profile simply gets no suggestion.
  const profileQuery = trpc.settings.businessProfile.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
  });
  const issuerCountry = profileQuery.data?.country ?? null;

  const allClients = React.useMemo<ClientRow[]>(
    () => {
      const stats = new Map(clientsQuery.data?.map((row) => [row.id, row]));
      return (metadata.data ?? clientsQuery.data ?? []).map((row) => {
        const totals = stats.get(row.id);
        return totals ? { ...row, entryCount: totals.entryCount, totalSec: totals.totalSec } : row;
      });
    },
    [metadata.data, clientsQuery.data],
  );
  const allProjects = React.useMemo<ProjectTableRow[]>(
    () => projectsQuery.data ?? [],
    [projectsQuery.data],
  );

  // Looked up in the unfiltered list: an archived client can still be billed.
  const linkedClient =
    link.billingClientId === null || linkDismissed
      ? null
      : (allClients.find((client) => client.id === link.billingClientId) ?? null);

  const needle = search.trim().toLowerCase();

  const visibleClients = React.useMemo(
    () =>
      allClients.filter((client) => {
        if (!showArchived && client.archived) return false;
        if (needle === "") return true;
        return client.name.toLowerCase().includes(needle);
      }),
    [allClients, showArchived, needle],
  );

  return (
    <CatalogScreen
      title={tc("fields.clients")}
      description={t("clients.description")}
      actionLabel={t("clients.new")}
      onAction={() => setCreating(true)}
      actionTestId="new-client"
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder={t("clients.search")}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      summary={tc("counts.clients", { count: visibleClients.length })}
      hasError={clientsQuery.isError}
      testId="clients-page"
    >
      <ClientsTable
        clients={visibleClients}
        projects={allProjects}
        isLoading={metadata.isPending && clientsQuery.isPending}
        statsPending={clientsQuery.isPending}
        isFiltered={needle !== ""}
        onCreate={() => setCreating(true)}
        issuerCountry={issuerCountry}
      />

      <ClientFormDialog
        open={creating}
        onOpenChange={setCreating}
        issuerCountry={issuerCountry}
      />

      <ClientFormDialog
        open={linkedClient !== null}
        onOpenChange={(next) => {
          if (!next) setLinkDismissed(true);
        }}
        client={linkedClient}
        focusBillingField={link.field}
        fromInvoiceId={link.fromInvoiceId}
        issuerCountry={issuerCountry}
      />
    </CatalogScreen>
  );
}
