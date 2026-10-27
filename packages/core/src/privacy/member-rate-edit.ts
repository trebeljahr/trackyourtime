import { updateMemberRateSchema, type PrivateKind } from "@starter/shared";
import { privateMemberQuery } from "./member-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import type { PlainPrivateRecord } from "./records.js";
export const PRIVATE_MEMBER_RATE_EDIT_KINDS: readonly PrivateKind[] = ["members", "memberMoney"];
/** A signed member's original private row is the mutation target. Live auth
 * member IDs are display metadata and cannot choose whose money is changed. */
export function privateMemberRateEdit(options: PrivateViewOptions & { input: unknown; now?: number }) {
  const source = privateViewSource(options), { scope } = options;
  const input = updateMemberRateSchema.strict().parse(options.input);
  if (input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) throw new Error("Private member rate edit belongs to another workspace");
  if (source.actor.role !== "owner" && !(source.actor.role === "admin" && source.actor.canViewOthersMoney)) throw new Error("member-rate-permission-required");
  const before = privateMemberQuery({ ...options, input: {} }), target = before.find(row => row.memberId === input.memberId);
  if (!target) throw new Error("Member not found");
  if (target.hourlyRate === input.hourlyRate) { source.check(); return { records: [], result: target }; }
  const original = source.ofKind("members").find(row => row.id === target.memberId)!, money = source.ofKind("memberMoney").find(row => row.id === target.memberId)!;
  source.value(original); source.paired(original, "memberMoney");
  const records: PlainPrivateRecord[] = [
    { ...original, value: { ...original.value, updatedAt: new Date(options.now ?? Date.now()).toISOString() } },
    { ...money, value: { ...money.value, hourlyRate: input.hourlyRate } },
  ];
  const changed = new Set(records.map(row => JSON.stringify([row.kind, row.id]))), after = options.records.filter(row => !changed.has(JSON.stringify([row.kind, row.id]))).concat(records);
  const result = privateMemberQuery({ ...options, input: {}, records: after }).find(row => row.memberId === target.memberId);
  if (!result) throw new Error("Prepared private member is missing");
  source.check(); return { records, result };
}
