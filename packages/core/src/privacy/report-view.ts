import { z } from "zod";
import {
  addDaysToKey, currencyAmountsAccumulator, dayKeyInZone, dayKeysBetween, entryAmount,
  detailedReportSchema, reportExportSchema, reportFiltersSchema, reportMoneyVisible, resolveTimeZone,
  singleCurrencyMoney, summaryReportSchema, weeklyReportSchema, zonedDayStartMs,
  type DetailedEntry, type DetailedReportResult,
  type SummaryReportResult, type SummaryTimelinePoint, type WeeklyReportResult,
  type WeeklyReportRow,
} from "@starter/shared";
import {
  accumulateGroups, clipReportToRange, FORMER_MEMBER_LABEL, measureReportEntry,
  projectDetailedReport, reportGroupIdentity, resolveMemberLabels, sortGroups,
  tagGroupIdentities, withholdSummaryMoney, type GroupAccumulator,
  type ReportRange, type TagLabel,
} from "../report-math.js";
import { privateEntryReader } from "./entry-view.js";
import { privateReportBoundForPolicy, privateReportRangeForPolicy, requirePrivateWorkspacePolicy, type VerifiedPrivateWorkspacePolicy } from "./mode-policy.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";

const paths = ["reports.rows", "reports.totals", "reports.detailed", "reports.summary", "reports.weekly"] as const;
export type PrivateReportQueryPath = typeof paths[number];
export const isPrivateReportQuery = (path: string): path is PrivateReportQueryPath => (paths as readonly string[]).includes(path);
const id = z.string().min(1).max(100);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const label = z.object({ _id: id, workspaceId: id, name: z.string().max(200) });
const projectSchema = label.extend({ color, clientId: id.nullish().transform((value) => value ?? null) });
const clientSchema = label.extend({ color: color.nullish().transform((value) => value ?? null) });
const hex = (value: string | null | undefined) => value && /^[0-9a-f]{24}$/i.test(value) ? value.toLowerCase() : null;
type Options = PrivateViewOptions & { policy: VerifiedPrivateWorkspacePolicy; path: PrivateReportQueryPath; input: unknown; now?: number };

/** Same report math as the standard engine, over one short-lived verified
 * local view. Filters, labels and decrypted results never leave this call. */
function readPrivateReport(options: Options, allRows = false): DetailedReportResult | SummaryReportResult | WeeklyReportResult | Pick<DetailedReportResult, "entries" | "nextCursor"> | Omit<DetailedReportResult, "entries" | "nextCursor"> {
  const { scope, path, policy } = options;
  if (!isPrivateReportQuery(path)) throw new Error("This private report query is not supported");
  const source = privateViewSource(options);
  const raw = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (raw.workspaceId !== undefined && raw.workspaceId !== scope.workspaceId) throw new Error("Private report filter belongs to another workspace");
  const { workspaceId: _scope, ...input } = raw; void _scope;
  const args = path === "reports.summary" ? summaryReportSchema.strict().parse(input)
    : path === "reports.weekly" ? weeklyReportSchema.strict().parse(input)
    : path === "reports.totals" ? reportFiltersSchema.strict().parse(input)
    : detailedReportSchema.extend({ cursor: z.string().max(512).optional() }).strict().parse(input);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("Invalid private report clock");
  // The signed policy supplies the old server's range calendar. Day buckets
  // retain the caller's separately selected zone, exactly as standard reports.
  let range: ReportRange;
  const timeZone = resolveTimeZone(args.timeZone);
  let days: string[] = [];
  if (path === "reports.weekly") {
    const first = dayKeyInZone(privateReportBoundForPolicy(policy, scope, (args as z.infer<typeof weeklyReportSchema>).weekStart), timeZone);
    days = Array.from({ length: 7 }, (_, index) => addDaysToKey(first, index));
    range = { fromMs: zonedDayStartMs(first, timeZone), toMs: zonedDayStartMs(addDaysToKey(first, 7), timeZone) };
  } else range = privateReportRangeForPolicy(policy, scope, args);
  const settingsRows = source.ofKind("settings");
  if (settingsRows.length > 1) throw new Error("Private workspace settings are ambiguous");
  const settings = settingsRows.length ? z.object({ currency: z.string().regex(/^[A-Z]{3}$/), weekStartsOn: z.union([z.literal(0), z.literal(1)]) }).parse(source.value(settingsRows[0]!)) : { currency: "EUR", weekStartsOn: 1 as const };
  const calendar = { timeZone, weekStartsOn: settings.weekStartsOn };
  const moneyVisible = reportMoneyVisible(source.visibility);
  const reader = privateEntryReader(source);
  // Catalog reads are shared facts only; no current rates can replace saved
  // financial snapshots. BSON ids are joined with the standard ObjectId rule.
  const projects = new Map(source.ofKind("projects").map((row) => [row.id, projectSchema.parse(source.value(row))]));
  const clients = new Map(source.ofKind("clients").map((row) => [row.id, clientSchema.parse(source.value(row))]));
  const tasks = new Map(source.ofKind("tasks").map((row) => [row.id, label.parse(source.value(row))]));
  const clientOf = (entry: typeof reader.quick[number]["doc"]) => entry.clientId === undefined ? projects.get(entry.projectId ?? "")?.clientId ?? null : entry.clientId;
  const search = args.search?.trim().toLowerCase() ?? "";
  const matching = reader.quick.filter(({ doc }) => Date.parse(doc.start) < range.toMs && (doc.end === null || Date.parse(doc.end) > range.fromMs)
    && (!args.memberIds?.length || args.memberIds.includes(doc.authorId))
    && (!args.projectIds || args.projectIds.includes(doc.projectId!))
    && (!args.clientIds?.length || args.clientIds.includes(clientOf(doc)!))
    && (!args.taskIds || args.taskIds.includes(doc.taskId!))
    && (!args.tagIds?.length || doc.tagIds.some((tag) => args.tagIds!.includes(tag)))
    && (args.billable === undefined || doc.billable === args.billable)
    && (!search || doc.description.toLowerCase().includes(search)))
    .sort((a, b) => Date.parse(b.doc.start) - Date.parse(a.doc.start) || (a.doc.id < b.doc.id ? 1 : a.doc.id > b.doc.id ? -1 : 0));
  if (allRows && matching.length > 100000) throw new Error("Private report export exceeds 100000 entries; choose a shorter range");
  const snapshot = (row: typeof matching[number]) => {
    const entry = reader.detailed(row, moneyVisible);
    const projectId = hex(entry.projectId), clientId = hex(clientOf(row.doc)), taskId = hex(entry.taskId);
    return { ...entry, start: new Date(entry.start), end: entry.end === null ? null : new Date(entry.end),
      project: projectId ? projects.get(projectId) ?? null : null,
      client: clientId ? clients.get(clientId) ?? null : null,
      task: taskId ? tasks.get(taskId) ?? null : null };
  };
  const finish = <T>(result: T): T => {
    source.check();
    // Check the actual branded policy again even when a caller supplied an
    // overly permissive current callback.
    requirePrivateWorkspacePolicy(policy, scope, "encrypted");
    const finite = (value: unknown): void => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Private report exceeds supported precision");
      if (Array.isArray(value)) for (const item of value) finite(item);
      else if (value !== null && typeof value === "object") for (const item of Object.values(value)) finite(item);
    };
    finite(result);
    return result;
  };
  const measured = (row: typeof matching[number]) => {
    const result = measureReportEntry(snapshot(row), range, now, calendar);
    if (result && (!Number.isSafeInteger(result.seconds) || !Number.isFinite(result.amount))) throw new Error("Private report exceeds supported precision");
    return result;
  };
  if (path === "reports.weekly") {
    const rows = new Map<string, WeeklyReportRow>(), dayIndex = new Map(days.map((day, index) => [day, index])), dayTotals = days.map(() => 0);
    let totalSec = 0;
    for (const raw of matching) {
      const entry = measured(raw); if (!entry) continue;
      const { project, task } = entry.doc, projectId = project?._id ?? null, taskId = task?._id ?? null;
      const key = `${projectId ?? ""}::${taskId ?? ""}`, projectName = project?.name ?? "No project";
      const row = rows.get(key) ?? { projectId, taskId, label: task ? `${projectName} – ${task.name}` : projectName, color: project?.color ?? null, daySeconds: days.map(() => 0), totalSec: 0 };
      for (const slice of entry.slices) {
        const index = dayIndex.get(slice.date); if (index === undefined) continue;
        row.daySeconds[index] = (row.daySeconds[index] ?? 0) + slice.seconds;
        dayTotals[index] = (dayTotals[index] ?? 0) + slice.seconds;
        row.totalSec += slice.seconds; totalSec += slice.seconds;
      }
      rows.set(key, row);
    }
    return finish({ days, rows: [...rows.values()].filter((row) => row.totalSec > 0).sort((a, b) => b.totalSec - a.totalSec || a.label.localeCompare(b.label)), dayTotals, totalSec, moneyVisible });
  }
  if (path === "reports.summary") {
    const groupBy = (args as z.infer<typeof summaryReportSchema>).groupBy;
    const tags = new Map<string, TagLabel>();
    if (groupBy === "tag") for (const row of source.ofKind("tags")) tags.set(row.id, z.object({ name: z.string().max(200), color, hidden: z.boolean().optional() }).parse(source.value(row)));
    const groups = new Map<string, GroupAccumulator>(), timeline = new Map<string, SummaryTimelinePoint>(), shares = new Map<string, Map<string, number>>();
    for (const date of dayKeysBetween(dayKeyInZone(range.fromMs, timeZone), dayKeyInZone(range.toMs - 1, timeZone))) {
      timeline.set(date, { date, seconds: 0, billableSec: 0, shares: [] }); shares.set(date, new Map());
    }
    let totalSec = 0, billableSec = 0;
    const amounts = currencyAmountsAccumulator(), authors = new Set<string>();
    for (const raw of matching) {
      authors.add(raw.doc.authorId);
      const entry = measured(raw); if (!entry) continue;
      totalSec += entry.seconds; billableSec += entry.billableSec; amounts.add({ amount: entry.amount, currency: entry.doc.currency });
      const identities = groupBy === "tag" ? tagGroupIdentities(entry.doc.tagIds, tags) : [reportGroupIdentity(entry, groupBy, scope.workspaceId, calendar)];
      accumulateGroups(groups, identities, { ...entry, currency: entry.doc.currency });
      for (const slice of entry.slices) {
        const point = timeline.get(slice.date), dayShares = shares.get(slice.date); if (!point || !dayShares) continue;
        point.seconds += slice.seconds; if (entry.doc.billable) point.billableSec += slice.seconds;
        for (const identity of identities) dayShares.set(identity.key, (dayShares.get(identity.key) ?? 0) + slice.seconds);
      }
    }
    if (groupBy === "member") {
      // Membership comes from the current verified directory. Departed names
      // are never republished from historical encrypted member records.
      const active = new Set(options.directory.signed.directory.members.map((member) => member.userId));
      const members = new Map<string, { name: string }>([...authors].filter((author) => active.has(author)).map((author) => [author, { name: "" }])), seen = new Set<string>();
      for (const row of source.ofKind("members")) {
        if (!row.authorId || !authors.has(row.authorId) || !active.has(row.authorId)) continue;
        const member = z.object({ userId: id, name: z.string().max(200).default("") }).parse(source.value(row));
        if (member.userId !== row.authorId || seen.has(member.userId)) throw new Error("Private report member identity is ambiguous");
        members.set(member.userId, member); seen.add(member.userId);
      }
      const labels = resolveMemberLabels(authors, members, new Map());
      for (const group of groups.values()) group.label = labels.get(group.key) ?? FORMER_MEMBER_LABEL;
    }
    for (const [date, dayShares] of shares) timeline.get(date)!.shares = [...dayShares].filter(([, seconds]) => seconds > 0).map(([key, seconds]) => ({ key, seconds })).sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
    const totalAmounts = amounts.result(), scalar = singleCurrencyMoney(totalAmounts, settings.currency);
    const result: SummaryReportResult = { totalSec, billableSec, totalAmount: scalar.amount, totalAmounts, currency: scalar.currency, groups: sortGroups(groups.values()), timeline: [...timeline.values()], moneyVisible: true };
    return finish(moneyVisible ? result : withholdSummaryMoney({ ...result, currency: settings.currency }));
  }
  const withRows = path !== "reports.totals", withTotals = path !== "reports.rows";
  let totalSec = 0;
  const amounts = currencyAmountsAccumulator();
  if (withTotals) for (const raw of matching) {
    const entry = reader.detailed(raw, moneyVisible), doc = { ...entry, start: new Date(entry.start), end: entry.end === null ? null : new Date(entry.end) }, clipped = clipReportToRange(doc, range, now); if (!clipped) continue;
    totalSec += clipped.seconds;
    // Measurement shares the standard per-entry cent rounding.
    amounts.add({ amount: entryAmount(clipped.seconds, doc.billable ? doc.hourlyRate : null), currency: doc.currency });
  }
  const page = args as z.infer<typeof detailedReportSchema>;
  let after = matching;
  if (page.cursor) {
    const separator = page.cursor.lastIndexOf("|"), start = Date.parse(page.cursor.slice(0, separator)), key = page.cursor.slice(separator + 1);
    if (separator < 0 || !Number.isFinite(start) || !hex(key)) throw new Error("Invalid private report cursor");
    after = matching.filter(({ doc }) => Date.parse(doc.start) < start || (Date.parse(doc.start) === start && doc.id < key.toLowerCase()));
  }
  const limit = allRows ? matching.length : page.limit ?? 50, window = withRows ? after.slice(0, limit) : [], entries: DetailedEntry[] = [];
  for (const raw of window) {
    const entry = measured(raw); if (!entry) continue;
    const { project, client, task, start, end, ...doc } = entry.doc;
    entries.push({ ...doc, start: start.toISOString(), end: end?.toISOString() ?? null, projectName: project?.name ?? null, projectColor: project?.color ?? null, clientName: client?.name ?? null, taskName: task?.name ?? null, amount: entry.amount });
  }
  const last = window.at(-1)?.doc, totalAmounts = amounts.result(), scalar = singleCurrencyMoney(totalAmounts, settings.currency);
  const result = projectDetailedReport({ entries, ...(withRows && after.length > limit && last ? { nextCursor: `${last.start}|${last.id}` } : {}), totalSec, totalAmount: scalar.amount, totalAmounts, currency: moneyVisible ? scalar.currency : settings.currency, moneyVisible: true }, source.visibility);
  if (path === "reports.rows") return finish({ entries: result.entries, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
  if (path === "reports.totals") { const { entries: _entries, nextCursor: _cursor, ...totals } = result; void _entries; void _cursor; return finish(totals); }
  return finish(result);
}

export function privateReportQuery(options: Options) { return readPrivateReport(options); }

/** One export uses one immutable local dataset and one clock. The public
 * page-size limit stays unchanged; exports never walk/reparse history per page. */
export function privateReportExportData(options: Omit<Options, "path">) {
  const input = reportExportSchema.extend({ workspaceId: id.optional() }).strict().parse(options.input);
  const { report, format: _format, groupBy, weekStart, locale: _locale, ...filters } = input;
  void _format; void _locale;
  const range = privateReportRangeForPolicy(options.policy, options.scope, input), timeZone = resolveTimeZone(input.timeZone);
  const currencyRows = options.records.filter((row) => row.kind === "settings");
  // Weekly results carry no currency, but their PDF still takes the workspace
  // display currency. Read it through the same checked source binding.
  const source = privateViewSource({ ...options, records: currencyRows });
  if (currencyRows.length > 1) throw new Error("Private workspace settings are ambiguous");
  const currency = currencyRows.length ? z.string().regex(/^[A-Z]{3}$/).parse(source.value(source.ofKind("settings")[0]!).currency) : "EUR";
  const filenameRange = { from: dayKeyInZone(range.fromMs, timeZone), to: dayKeyInZone(range.toMs - 1, timeZone) };
  if (report === "summary") return { report, filenameRange, currency, result: readPrivateReport({ ...options, path: "reports.summary", input: { ...filters, groupBy: groupBy ?? "project" } }) as SummaryReportResult };
  if (report === "weekly") return { report, filenameRange, currency, result: readPrivateReport({ ...options, path: "reports.weekly", input: { ...filters, weekStart: weekStart ?? filenameRange.from } }) as WeeklyReportResult };
  return { report, filenameRange, currency, result: readPrivateReport({ ...options, path: "reports.detailed", input: filters }, true) as DetailedReportResult };
}
