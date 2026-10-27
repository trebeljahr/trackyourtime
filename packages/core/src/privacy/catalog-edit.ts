import { z } from "zod";
import { budgetWrite, clientBillingSchema, createClientSchema, createProjectSchema, createTagSchema, createTaskSchema, electronicAddressProblems, EMPTY_CLIENT_BILLING, idInputSchema, mergeIdentityInput, normalizeClientBilling, pickCatalogColor, PROJECT_COLOR_OFFSET, TAG_COLOR_OFFSET, TASK_COLOR_OFFSET, updateClientSchema, updateProjectWithEntriesSchema, updateTagSchema, updateTaskSchema, type ClientBillingFields, type PrivateKind } from "@starter/shared";
import { privateCatalogQuery } from "./catalog-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import type { PlainPrivateRecord } from "./records.js";
const createSchemas = { clients: createClientSchema, projects: createProjectSchema, tasks: createTaskSchema, tags: createTagSchema };
const updateSchemas = { clients: updateClientSchema, projects: updateProjectWithEntriesSchema, tasks: updateTaskSchema, tags: updateTagSchema };
type Kind = keyof typeof createSchemas;
const paths = ["clients.create", "clients.update", "clients.archive", "projects.create", "projects.update", "projects.archive", "tasks.create", "tasks.update", "tasks.archive", "tags.create", "tags.update"] as const;
export type PrivateCatalogEditPath = typeof paths[number];
export const isPrivateCatalogEdit = (path: string): path is PrivateCatalogEditPath => (paths as readonly string[]).includes(path);
export const PRIVATE_CATALOG_EDIT_KINDS: readonly PrivateKind[] = ["clients", "clientMoney", "projects", "projectMoney", "tasks", "tags", "settings", "settingsMoney", "members", "memberMoney"];
const archiveSchema = idInputSchema.extend({ archived: z.boolean().optional() });
const names = new Intl.Collator("en", { sensitivity: "accent" });
const moneyKinds = { clients: "clientMoney", projects: "projectMoney" } as const;
function mergedBilling(stored: unknown, input: ClientBillingFields | null) {
  if (input === null) return null;
  const base = normalizeClientBilling(stored == null ? null : clientBillingSchema.parse(stored)) ?? EMPTY_CLIENT_BILLING;
  const merged = mergeIdentityInput<ClientBillingFields>(base, input);
  if (electronicAddressProblems(merged, false).length) throw new Error("Client billing address is incomplete");
  return normalizeClientBilling(merged);
}
/** Changes catalog facts only. No cascade, entry repricing, permission edit or
 * project reassignment may be hidden inside a catalog metadata update. */
export function privateCatalogEdit(options: PrivateViewOptions & { path: PrivateCatalogEditPath; input: unknown; now?: number; newId?: () => string }) {
  const { scope } = options, source = privateViewSource(options), { check, ofKind, value, paired } = source;
  if (source.actor.role !== "owner" && source.actor.role !== "admin") throw new Error("Verified workspace permissions forbid catalog changes");
  if (!isPrivateCatalogEdit(options.path)) throw new Error("Unsupported private catalog edit");
  const [kind, action] = options.path.split(".") as [Kind, "create" | "update" | "archive"];
  const input = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) throw new Error("Private catalog intent belongs to another workspace");
  const { workspaceId: _workspace, ...raw } = input; void _workspace;
  const args = (action === "create" ? createSchemas[kind].strict().parse(raw) : action === "update" ? updateSchemas[kind].strict().parse(raw) : archiveSchema.strict().parse(raw)) as Record<string, unknown>;
  if (args.applyToEntries === true) throw new Error("Private entry repricing requires a separate verified transition");
  const rows = ofKind(kind), prior = action === "create" ? undefined : rows.find((row) => row.id === args.id);
  if (action !== "create" && !prior) throw new Error("Catalog record not found");
  if (prior && prior.authorId !== null) throw new Error("Shared catalog record has an unexpected author");
  const current = prior ? value(prior) : null;
  const newId = prior?.id ?? z.uuid().parse((options.newId ?? (() => crypto.randomUUID()))());
  if (!prior && rows.some((row) => row.id === newId)) throw new Error("New catalog identity already exists");
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  const offset = kind === "tags" ? TAG_COLOR_OFFSET : kind === "tasks" ? TASK_COLOR_OFFSET : kind === "projects" ? PROJECT_COLOR_OFFSET : 0;
  const body: Record<string, unknown> = prior ? { ...prior.value } : { _id: newId, workspaceId: scope.workspaceId, createdBy: scope.userId, color: pickCatalogColor(rows.length, offset), archived: false, createdAt: stamp };
  body.updatedAt = stamp;
  if (args.name !== undefined) {
    const name = z.string().parse(args.name).trim(); if (!name) throw new Error("Catalog name is required");
    if (rows.some((row) => row.id !== newId && names.compare(z.string().parse(value(row).name), name) === 0)) throw new Error("Catalog name already exists"); body.name = name;
  }
  if (action === "archive") body.archived = args.archived ?? true;
  for (const key of ["color", "archived"]) if (args[key] !== undefined) body[key] = args[key];
  let financial: PlainPrivateRecord | null = null;
  const getFinancial = () => {
    if (kind !== "clients" && kind !== "projects") throw new Error("Unexpected catalog financial record");
    const moneyKind = moneyKinds[kind];
    if (financial) return financial.value;
    const stored = prior ? ofKind(moneyKind).find((row) => row.id === prior.id) : null;
    if (prior) paired(prior, moneyKind);
    financial = { kind: moneyKind, id: newId, authorId: null, value: stored ? { ...stored.value } : { _id: newId, workspaceId: scope.workspaceId } }; return financial.value;
  };
  if (kind === "tags") {
    if (!prior) body.hidden = false;
    if (args.hidden !== undefined) body.hidden = args.hidden;
  }
  if (kind === "clients") {
    if (!prior) { body.invoiceLocale = args.invoiceLocale ?? null; getFinancial().billing = args.billing === undefined ? null : mergedBilling(null, args.billing as ClientBillingFields | null); }
    else {
      if (args.invoiceLocale !== undefined) body.invoiceLocale = args.invoiceLocale;
      if (args.billing !== undefined) getFinancial().billing = mergedBilling(paired(prior, "clientMoney").billing, args.billing as ClientBillingFields | null);
    }
  }
  if (kind === "projects") {
    if (prior && args.clientId !== undefined && args.clientId !== (current?.clientId ?? null)) throw new Error("Project reassignment requires preserving every member's historical client snapshots");
    if (typeof args.clientId === "string") {
      const client = ofKind("clients").find((row) => row.id === args.clientId); if (!client || client.authorId !== null) throw new Error("Client not found"); value(client);
    }
    if (!prior) { Object.assign(body, { clientId: args.clientId ?? null, billableDefault: args.billableDefault ?? true, idleBehavior: args.idleBehavior ?? null, estimatedHours: null }); Object.assign(getFinancial(), { hourlyRate: args.hourlyRate ?? null, budgetAmount: null, budgetCurrency: null }); }
    else for (const key of ["clientId", "billableDefault", "idleBehavior"]) if (args[key] !== undefined) body[key] = args[key];
    if (args.hourlyRate !== undefined) getFinancial().hourlyRate = args.hourlyRate;
    const existingMoney = prior ? paired(prior, "projectMoney") : {};
    const settings = ofKind("settings"); if (settings.length > 1) throw new Error("Duplicate workspace settings");
    const currency = settings.length ? z.string().regex(/^[A-Z]{3}$/).parse(value(settings[0]!).currency) : "";
    const budget = budgetWrite(args, currency, { budgetAmount: z.number().finite().nonnegative().nullish().parse(existingMoney.budgetAmount) ?? null, budgetCurrency: z.string().regex(/^[A-Z]{3}$/).nullish().parse(existingMoney.budgetCurrency) ?? null });
    if (budget.estimatedHours !== undefined) body.estimatedHours = budget.estimatedHours;
    for (const key of ["budgetAmount", "budgetCurrency"]) if (budget[key] !== undefined) getFinancial()[key] = budget[key];
  }
  const updated: PlainPrivateRecord = { kind, id: newId, authorId: null, value: body };
  const records: PlainPrivateRecord[] = [updated, ...(financial ? [financial] : [])];
  const changed = new Set(records.map((row) => JSON.stringify([row.kind, row.id]))), after = options.records.filter((row) => !changed.has(JSON.stringify([row.kind, row.id]))).concat(records);
  const path = kind === "tags" ? "tags.list" : `${kind}.options` as "clients.options" | "projects.options" | "tasks.options";
  const resultRows = privateCatalogQuery({ ...options, records: after.filter((row) => PRIVATE_CATALOG_EDIT_KINDS.includes(row.kind)), path, input: { includeArchived: true, ...(kind === "tags" ? { includeHidden: true } : {}) } });
  if (!Array.isArray(resultRows)) throw new Error("Catalog result is not a list");
  const result = resultRows.find((row) => row.id === newId); if (!result) throw new Error("Prepared catalog result is missing");
  const { entryCount: _count, totalSec: _seconds, clientName: _clientName, clientColor: _clientColor, ...wire } = result as unknown as Record<string, unknown>; void _count; void _seconds; void _clientName; void _clientColor;
  check(); return { records, result: kind === "projects" && action === "update" ? { ...wire, entriesRewritten: null } : wire };
}
