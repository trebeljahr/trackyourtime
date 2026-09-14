// Clients: the top of the catalog (Client → Project → Task).
//
// Every query is scoped by `workspaceId`, so a document owned by somebody else
// is indistinguishable from a missing one (NOT_FOUND, never FORBIDDEN).
import { TRPCError } from "@trpc/server";
import {
  normalizeClientBilling,
  pickCatalogColor,
  type Client as ClientWire,
  type ClientListInput,
  type CreateClientInput,
  type UpdateClientInput,
} from "@starter/shared";
import { Client, toClientClient } from "../../models/Client.js";
import { publishSync } from "../../ws/sync.js";
import type { CatalogRemoveResult } from "../../trpc/routers/catalog-cascade.js";
import { cascadeDeleteClient } from "../../trpc/routers/catalog-cascade.js";
import type { WorkspaceScope } from "../scope.js";
import { assertObjectId } from "./guards.js";
import { assertUniqueCatalogName } from "./names.js";

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Client not found" });

const assertUniqueClientName = (
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<void> =>
  assertUniqueCatalogName({
    model: Client,
    filter: { workspaceId },
    name,
    ...(excludeId ? { excludeId } : {}),
    label: "client",
  });

export async function listClients(
  scope: WorkspaceScope,
  input: ClientListInput,
): Promise<ClientWire[]> {
  const docs = await Client.find({
    workspaceId: scope.workspaceId,
    ...(input.includeArchived ? {} : { archived: false }),
  })
    .collation({ locale: "en", strength: 2 })
    .sort({ name: 1 })
    .lean();

  return docs.map(toClientClient);
}

/** One client by id. Same `{ _id, workspaceId }` filter as everything else. */
export async function getClient(
  scope: WorkspaceScope,
  id: string,
): Promise<ClientWire> {
  assertObjectId(id);
  const doc = await Client.findOne({
    _id: id,
    workspaceId: scope.workspaceId,
  }).lean();
  if (!doc) throw notFound();
  return toClientClient(doc);
}

export async function createClient(
  scope: WorkspaceScope,
  input: CreateClientInput,
): Promise<ClientWire> {
  const name = input.name.trim();
  await assertUniqueClientName(scope.workspaceId, name);

  const existing = await Client.countDocuments({
    workspaceId: scope.workspaceId,
  });
  // Written only when there is something to write, so a client created
  // without billing details looks exactly like one created before they existed.
  const billing = normalizeClientBilling(input.billing);
  const created = await Client.create({
    workspaceId: scope.workspaceId,
    createdBy: scope.userId,
    name,
    color: input.color ?? pickCatalogColor(existing),
    archived: false,
    ...(billing ? { billing } : {}),
    invoiceLocale: input.invoiceLocale ?? null,
  });

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "client" },
    input.originId,
  );
  return toClientClient(created);
}

export async function updateClient(
  scope: WorkspaceScope,
  input: UpdateClientInput,
): Promise<ClientWire> {
  assertObjectId(input.id);
  if (input.name !== undefined) {
    await assertUniqueClientName(scope.workspaceId, input.name, input.id);
  }

  const updated = await Client.findOneAndUpdate(
    { _id: input.id, workspaceId: scope.workspaceId },
    {
      $set: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(input.invoiceLocale !== undefined
          ? { invoiceLocale: input.invoiceLocale }
          : {}),
        // Replaces the subdocument whole; an all-blank one clears it to null.
        ...(input.billing !== undefined
          ? { billing: normalizeClientBilling(input.billing) }
          : {}),
      },
    },
    { returnDocument: "after" },
  ).lean();

  if (!updated) throw notFound();

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "client" },
    input.originId,
  );
  return toClientClient(updated);
}

export async function archiveClient(
  scope: WorkspaceScope,
  input: { id: string; archived?: boolean; originId?: string },
): Promise<ClientWire> {
  assertObjectId(input.id);

  const updated = await Client.findOneAndUpdate(
    { _id: input.id, workspaceId: scope.workspaceId },
    { $set: { archived: input.archived ?? true } },
    { returnDocument: "after" },
  ).lean();

  if (!updated) throw notFound();

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "client" },
    input.originId,
  );
  return toClientClient(updated);
}

/**
 * Always deletes. Its projects survive as client-less projects, so no
 * tracked time is lost. Use `archive` to keep the client around instead.
 *
 * The only count this cascade reports is `projectsDetached`, so — unlike
 * `removeProject` and `removeTask` — the result needs no narrowing before it
 * goes back: projects are CATALOG rows every member may already list in full.
 * Give this cascade entries or favorites to touch and that stops being true,
 * and it owes `ownCascadeCollateral` the same call the other two make.
 */
export async function removeClient(
  scope: WorkspaceScope,
  input: { id: string; originId?: string },
): Promise<CatalogRemoveResult> {
  assertObjectId(input.id);

  const client = await Client.findOne({
    _id: input.id,
    workspaceId: scope.workspaceId,
  }).lean();
  if (!client) throw notFound();

  const result = await cascadeDeleteClient(scope.workspaceId, input.id);

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "client" },
    input.originId,
  );
  return result;
}
