"use client";

import * as React from "react";

import { CatalogScreen } from "@/components/catalog/catalog-screen";
import { ClientFormDialog } from "@/components/catalog/client-form-dialog";
import { ClientsTable } from "@/components/catalog/clients-table";
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

  const clientsQuery = trpc.clients.list.useQuery(CLIENT_LIST_INPUT, {
    staleTime: 30_000,
  });
  // The roll-ups on each client row are derived from the project list.
  const projectsQuery = trpc.projects.list.useQuery(PROJECT_LIST_INPUT, {
    staleTime: 30_000,
  });

  const allClients = React.useMemo<ClientRow[]>(
    () => clientsQuery.data ?? [],
    [clientsQuery.data],
  );
  const allProjects = React.useMemo<ProjectRow[]>(
    () => projectsQuery.data ?? [],
    [projectsQuery.data],
  );

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
      />

      <ClientFormDialog open={creating} onOpenChange={setCreating} />
    </CatalogScreen>
  );
}
