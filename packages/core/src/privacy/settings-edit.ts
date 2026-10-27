import { z } from "zod";
import { updateSettingsSchema, type PrivateKind } from "@starter/shared";
import { privateSettingsQuery } from "./settings-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import type { PlainPrivateRecord } from "./records.js";
export const PRIVATE_SETTINGS_EDIT_KINDS: readonly PrivateKind[] = ["settings", "settingsMoney", "members", "memberMoney"];
const schema = updateSettingsSchema.pick({ defaultHourlyRate: true, currency: true, weekStartsOn: true, originId: true }).strict();
/** Workspace money/calendar only. Reject personal or mixed patches before any
 * write; account rendering preferences have a different owner and protocol. */
export function privateSettingsEdit(options: PrivateViewOptions & { input: unknown; preferences: unknown; now?: number; newId?: () => string }) {
  const source = privateViewSource(options), { check, ofKind, value, paired } = source;
  const raw = z.record(z.string(), z.unknown()).parse(options.input ?? {}), { workspaceId, ...patch } = raw;
  if (workspaceId !== undefined && workspaceId !== options.scope.workspaceId) throw new Error("Private settings edit belongs to another workspace");
  const args = schema.parse(patch);
  if (source.actor.role === "member") throw new Error("Only an owner or admin can change workspace settings");
  // Validate the complete original state before retaining its unknown fields.
  privateSettingsQuery({ ...options, input: {} });
  const rows = ofKind("settings"), prior = rows[0], records: PlainPrivateRecord[] = [];
  if ([args.currency, args.weekStartsOn, args.defaultHourlyRate].some(v => v !== undefined)) {
    const newId = prior?.id ?? z.uuid().parse((options.newId ?? (() => crypto.randomUUID()))());
    if (!prior && ofKind("settingsMoney").some(row => row.id === newId)) throw new Error("New settings identity already exists");
    if (prior && prior.authorId !== null) throw new Error("Shared workspace settings have an unexpected author");
    const stamp = new Date(options.now ?? Date.now()).toISOString();
    const body = prior ? { ...prior.value } : { _id: newId, workspaceId: options.scope.workspaceId, currency: "EUR", weekStartsOn: 1, createdAt: stamp };
    Object.assign(body, { updatedAt: stamp }, args.currency === undefined ? {} : { currency: args.currency }, args.weekStartsOn === undefined ? {} : { weekStartsOn: args.weekStartsOn });
    records.push({ kind: "settings", id: newId, authorId: null, value: body });
    if (!prior || args.defaultHourlyRate !== undefined) {
      const original = prior ? ofKind("settingsMoney").find(row => row.id === newId)! : null;
      if (prior) { value(prior); paired(prior, "settingsMoney"); }
      records.push({ kind: "settingsMoney", id: newId, authorId: null, value: { ...(original?.value ?? { _id: newId, workspaceId: options.scope.workspaceId }), defaultHourlyRate: args.defaultHourlyRate ?? 0 } });
    }
  }
  const changed = new Set(records.map(row => JSON.stringify([row.kind, row.id])));
  const result = privateSettingsQuery({ ...options, input: {}, records: options.records.filter(row => !changed.has(JSON.stringify([row.kind, row.id]))).concat(records) });
  check(); return { records, result };
}
