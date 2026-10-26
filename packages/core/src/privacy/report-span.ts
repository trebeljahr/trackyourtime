import { z } from "zod";
import { canSeeEntry, dayKeyInZone, resolveTimeZone, trackedSpanSchema, type TrackedSpan } from "@starter/shared";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
const instant = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));
const spanEntry = z.object({ authorId: z.string().min(1).max(100), start: instant, end: instant.nullish().transform((value) => value ?? null) });
/** Calendar bounds only; no rates, descriptions or other members' private
 * data are needed. A member filter narrows the verified visibility scope. */
export function privateReportTrackedSpan(options: PrivateViewOptions & { input: unknown; now?: number }): TrackedSpan {
  const source = privateViewSource(options), { scope } = options;
  const input = trackedSpanSchema.extend({ workspaceId: z.string().min(1).max(100).optional() }).strict().parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) throw new Error("Private report filter belongs to another workspace");
  const now = options.now ?? Date.now(); if (!Number.isFinite(now)) throw new Error("Invalid private report clock");
  let first = Infinity, last = now;
  const requested = input.memberIds?.length ? new Set(input.memberIds) : null;
  for (const row of source.ofKind("entries")) {
    const entry = spanEntry.parse(source.value(row));
    if (entry.authorId !== row.authorId || !canSeeEntry(source.visibility, entry.authorId)) throw new Error("Private report includes ungranted time");
    if (requested && !requested.has(entry.authorId)) continue;
    first = Math.min(first, entry.start); last = Math.max(last, entry.start, entry.end ?? 0);
  }
  source.check(); if (first === Infinity) return { from: null, to: null };
  const zone = resolveTimeZone(input.timeZone); return { from: dayKeyInZone(first, zone), to: dayKeyInZone(last, zone) };
}
