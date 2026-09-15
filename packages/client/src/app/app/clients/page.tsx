"use client";

import * as React from "react";

import { CatalogScreen } from "@/components/catalog/catalog-screen";
import { ClientFormDialog } from "@/components/catalog/client-form-dialog";
import { ClientsTable } from "@/components/catalog/clients-table";
import { useDeepLink } from "@/components/einvoice/use-deep-link-focus";
import {
  CLIENT_LIST_INPUT,
  PROJECT_LIST_INPUT,
  type ClientRow,
  type ProjectRow,
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

  const clientsQuery = trpc.clients.list.useQuery(CLIENT_LIST_INPUT, {
    staleTime: 30_000,
  });
  // The roll-ups on each client row are derived from the project list.
  const projectsQuery = trpc.projects.list.useQuery(PROJECT_LIST_INPUT, {
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
    () => clientsQuery.data ?? [],
    [clientsQuery.data],
  );
  const allProjects = React.useMemo<ProjectRow[]>(
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
        isLoading={clientsQuery.isLoading}
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
