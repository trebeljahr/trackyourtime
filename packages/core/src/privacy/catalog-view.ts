import { z } from "zod";
import { canSeeEntry, clientBillingSchema, clientListSchema, computeBudgetProgress, entryDurationSec, hasBudgetTarget, IDLE_BEHAVIORS, normalizeClientBilling, pickCatalogColor, projectBillableByDefault, projectListSchema, projectProjectForVisibility, resolveHourlyRate, rollupVisibility, SUPPORTED_LOCALES, tagListSchema, taskListSchema, TASK_COLOR_OFFSET, type Client, type Project, type Tag, type Task } from "@starter/shared";
import type { VerifiedPrivateDirectory } from "./directory.js";
import type { PlainPrivateRecord } from "./records.js";
import { privateViewSource } from "./view-source.js";
const id = z.string().min(1).max(100), nullableId = id.nullish().transform((value) => value ?? null);
const timestamp = z.iso.datetime().transform((value) => new Date(value).toISOString());
const money = z.number().finite().nonnegative().nullable().optional().transform((value) => value ?? null);
const common = z.object({ _id: id, workspaceId: id, createdBy: z.string().max(100).default(""), name: z.string().min(1).max(200), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), archived: z.boolean(), createdAt: timestamp, updatedAt: timestamp });
const clientSchema = common.extend({ invoiceLocale: z.enum(SUPPORTED_LOCALES).nullish().transform((value) => value ?? null) });
const projectSchema = common.extend({ clientId: nullableId, billableDefault: z.boolean(), estimatedHours: money, idleBehavior: z.enum(IDLE_BEHAVIORS).nullish().transform((value) => value ?? null) });
const projectMoneySchema = z.object({ hourlyRate: money, budgetAmount: money, budgetCurrency: z.string().regex(/^[A-Z]{3}$/).nullish().transform((value) => value ?? null) });
const entrySchema = z.object({ _id: id, workspaceId: id, authorId: id, projectId: nullableId, taskId: nullableId, clientId: id.nullable().optional(), tagIds: z.array(id).default([]), durationSec: z.number().int().nonnegative(), start: timestamp, end: timestamp.nullish().transform((value) => value ?? null), billable: z.boolean(), currency: z.string().regex(/^[A-Z]{3}$/) });
const supported = ["clients.list", "clients.options", "projects.list", "projects.options", "tasks.list", "tasks.options", "tasks.projectLinks", "tags.list"] as const;
export type PrivateCatalogQueryPath = typeof supported[number];
export const isPrivateCatalogQuery = (path: string): path is PrivateCatalogQueryPath => (supported as readonly string[]).includes(path);
type Scope = { server: string; workspaceId: string; userId: string };
const wire = ({ _id, ...row }: z.infer<typeof common>) => ({ id: _id, ...row });
const sorted = <T extends { id: string; name: string }>(rows: T[]) => rows.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "accent" }) || a.id.localeCompare(b.id));
/** Pure read projection over a verified/decrypted replica. It uses the same
 * visibility and billing math as standard workspace reads. No API, persistence
 * or root keys. The caller owns decrypted view lifetime and must discard its
 * result on lock; this function never installs state or replays pending edits. */
export function privateCatalogQuery(options: {
  path: PrivateCatalogQueryPath; input: unknown; scope: Scope; directory: VerifiedPrivateDirectory;
  records: readonly PlainPrivateRecord[]; current: () => boolean; now?: number;
}) {
  const { path, scope, directory, current } = options;
  const { check, visibility, value, ofKind, paired } = privateViewSource({ scope, directory, records: options.records, current });
  const input = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) throw new Error("Private catalog filter belongs to another workspace");
  const { workspaceId: _workspace, ...filter } = input; void _workspace;
  const baseClients = () => sorted(ofKind("clients").map((row): Client => {
    const doc = clientSchema.parse(value(row)), financial = paired(row, "clientMoney");
    const billing = financial.billing === undefined || financial.billing === null ? null : normalizeClientBilling(clientBillingSchema.parse(financial.billing));
    return { ...wire(doc), invoiceLocale: doc.invoiceLocale, billing };
  }));
  let cachedEntries: { row: PlainPrivateRecord; doc: z.infer<typeof entrySchema> }[] | undefined;
  const entries = () => cachedEntries ??= ofKind("entries").map((row) => {
    const doc = entrySchema.parse(value(row));
    if (doc.authorId !== row.authorId || !canSeeEntry(visibility, doc.authorId)) throw new Error("Private catalog includes another member's ungranted time");
    return { row, doc };
  });
  let cachedRollup: ReturnType<typeof entries> | undefined;
  const rollupEntries = () => cachedRollup ??= entries().filter(({ doc }) => canSeeEntry(rollupVisibility(visibility), doc.authorId));
  type Usage = { entryCount: number; totalSec: number };
  const usage = new Map<string, Map<string, Usage>>();
  const stats = (kind: "clients" | "projects" | "tasks" | "tags", target: string) => {
    let table = usage.get(kind);
    if (!table) {
      table = new Map(); usage.set(kind, table);
      const projects = kind === "clients" ? new Map(ofKind("projects").map((row) => { const doc = projectSchema.parse(value(row)); return [doc._id, doc]; })) : null;
      for (const { doc } of rollupEntries()) {
        const ids = kind === "tags" ? doc.tagIds : [kind === "projects" ? doc.projectId : kind === "tasks" ? doc.taskId : doc.clientId === undefined ? (doc.projectId ? projects!.get(doc.projectId)?.clientId ?? null : null) : doc.clientId];
        for (const id of ids) if (id) {
          const next = table.get(id) ?? { entryCount: 0, totalSec: 0 }; next.entryCount++; next.totalSec += doc.durationSec;
          if (!Number.isSafeInteger(next.totalSec)) throw new Error("Private catalog time totals exceed supported precision"); table.set(id, next);
        }
      }
    }
    return table.get(target) ?? { entryCount: 0, totalSec: 0 };
  };
  let budgetGroups: Map<string, ReturnType<typeof entries>> | undefined;
  const projectEntries = (id: string) => {
    if (!budgetGroups) { budgetGroups = new Map(); for (const entry of entries()) if (entry.doc.projectId) { const group = budgetGroups.get(entry.doc.projectId) ?? []; group.push(entry); budgetGroups.set(entry.doc.projectId, group); } }
    return budgetGroups.get(id) ?? [];
  };
  const allProjects = () => {
    const settings = ofKind("settings"); if (settings.length > 1) throw new Error("Private catalog contains duplicate workspace settings");
    const defaultRate = settings.length ? z.number().finite().nonnegative().parse(paired(settings[0]!, "settingsMoney").defaultHourlyRate ?? 0) : 0;
    const ownMember = ofKind("members").find((row) => row.authorId === scope.userId);
    const memberRate = ownMember ? money.parse(paired(ownMember, "memberMoney").hourlyRate) : null;
    const effectiveRate = resolveHourlyRate({ billable: true, projectRate: null, memberRate, defaultRate }) ?? 0;
    const clients = new Map(baseClients().map((row) => [row.id, row]));
    return sorted(ofKind("projects").map((row) => {
      const doc = projectSchema.parse(value(row)), financial = projectMoneySchema.parse(paired(row, "projectMoney"));
      if ((financial.budgetAmount === null) !== (financial.budgetCurrency === null)) throw new Error("Private project budget currency is incomplete");
      const project: Project = { ...wire(doc), clientId: doc.clientId, billableDefault: doc.billableDefault, estimatedHours: doc.estimatedHours, idleBehavior: doc.idleBehavior, ...financial };
      const client = project.clientId ? clients.get(project.clientId) : undefined;
      return { ...project, billableDefault: projectBillableByDefault(project, effectiveRate), clientName: client?.name ?? null, clientColor: client?.color ?? null };
    }));
  };
  let result;
  switch (path) {
    case "clients.list": case "clients.options": {
      const args = clientListSchema.strict().parse(filter), clients = baseClients().filter((row) => args.includeArchived || !row.archived);
      if (path === "clients.options") { result = clients; break; }
      result = clients.map((row) => ({ ...row, ...stats("clients", row.id) })); break;
    }
    case "projects.list": case "projects.options": {
      const args = projectListSchema.strict().parse(filter), projects = allProjects().filter((row) => (args.includeArchived || !row.archived) && (args.clientId === undefined || row.clientId === args.clientId));
      if (path === "projects.options") { result = projects; break; }
      result = projects.map((row) => {
        const budgetEntries = visibility.canViewOthersTime && visibility.canViewOthersMoney && hasBudgetTarget(row) ? projectEntries(row.id).map(({ row: raw, doc }) => ({ seconds: entryDurationSec(doc, options.now ?? Date.now()), billable: doc.billable, hourlyRate: money.parse(paired(raw, "entryMoney").hourlyRate), currency: doc.currency })) : null;
        return projectProjectForVisibility({ ...row, ...stats("projects", row.id), progress: budgetEntries ? computeBudgetProgress(row, budgetEntries) : null }, visibility);
      }); break;
    }
    case "tasks.list": case "tasks.options": case "tasks.projectLinks": {
      const args = path === "tasks.projectLinks" ? taskListSchema.pick({}).strict().parse(filter) : taskListSchema.strict().parse(filter);
      const tasks = sorted(ofKind("tasks").map((row): Task & { legacyProjectId: string | null } => {
        const raw = value(row), doc = common.parse({ ...raw, color: raw.color ?? pickCatalogColor(0, TASK_COLOR_OFFSET) });
        return { ...wire(doc), legacyProjectId: raw.projectId === undefined ? null : nullableId.parse(raw.projectId) };
      }));
      if (path === "tasks.options") { result = tasks.filter((row) => (args as { includeArchived?: boolean }).includeArchived || !row.archived).map(({ legacyProjectId: _legacy, ...row }) => { void _legacy; return row; }); break; }
      const links = new Map<string, Set<string>>(), add = (task: string, project: string) => { const set = links.get(task) ?? new Set(); set.add(project); links.set(task, set); };
      for (const row of tasks) if (row.legacyProjectId) add(row.id, row.legacyProjectId);
      for (const { doc } of rollupEntries()) if (doc.taskId && doc.projectId) add(doc.taskId, doc.projectId);
      if (path === "tasks.projectLinks") { result = Object.fromEntries([...links].map(([task, projects]) => [task, [...projects].sort()])); break; }
      result = tasks.filter((row) => (args as { includeArchived?: boolean }).includeArchived || !row.archived).map(({ legacyProjectId: _legacy, ...row }) => { void _legacy; return { ...row, ...stats("tasks", row.id), projectIds: [...(links.get(row.id) ?? [])].sort() }; }); break;
    }
    case "tags.list": {
      const args = tagListSchema.strict().parse(filter);
      result = sorted(ofKind("tags").map((row): Tag => { const raw = value(row); return { ...wire(common.parse(raw)), hidden: z.boolean().parse(raw.hidden ?? false) }; })).filter((row) => (args.includeArchived || !row.archived) && (args.includeHidden || !row.hidden)).map((row) => ({ ...row, ...stats("tags", row.id) })); break;
    }
    default: throw new Error("This private catalog query is not supported");
  }
  check(); return result;
}
