import { z } from "zod";
import type { Visibility } from "@starter/shared";
import { assertVerifiedPrivateDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { privateValue, type PlainPrivateRecord } from "./records.js";
export type PrivateViewScope = { server: string; workspaceId: string; userId: string };
export type PrivateViewOptions = { scope: PrivateViewScope; directory: VerifiedPrivateDirectory; records: readonly PlainPrivateRecord[]; current: () => boolean };
const address = (row: Pick<PlainPrivateRecord, "kind" | "id">) => JSON.stringify([row.kind, row.id]);
/** Read-only, short-lived decrypted view. A verified directory chooses access;
 * server claims, cached UI flags and query inputs never grant visibility. */
export function privateViewSource({ scope, directory, records: input, current }: PrivateViewOptions) {
  const check = () => { if (!current()) throw new Error("Private view changed during this read"); assertVerifiedPrivateDirectory(directory); };
  check();
  if (directory.signed.directory.server !== scope.server || directory.signed.directory.workspaceId !== scope.workspaceId) throw new Error("Private view belongs to another workspace");
  const actor = directory.signed.directory.members.find((member) => member.userId === scope.userId);
  if (!actor) throw new Error("Private view reader is absent from the trusted directory");
  const visibility: Visibility = { userId: scope.userId, canViewOthersTime: actor.role === "owner" || actor.canViewOthersTime, canViewOthersMoney: actor.role === "owner" || actor.canViewOthersMoney };
  const rows = structuredClone(input), byAddress = new Map<string, PlainPrivateRecord>(), values = new Map<string, Record<string, unknown>>();
  for (const row of rows) { const key = address(row); if (byAddress.has(key)) throw new Error("Duplicate private view record"); byAddress.set(key, row); }
  const value = (row: PlainPrivateRecord) => {
    const key = address(row), found = values.get(key); if (found) return found;
    const decoded = z.record(z.string(), z.unknown()).parse(privateValue(row.value));
    if (decoded._id !== row.id || (decoded.workspaceId !== undefined && decoded.workspaceId !== scope.workspaceId)) throw new Error("Private view record identity differs from its workspace");
    values.set(key, decoded); return decoded;
  };
  const ofKind = (kind: PlainPrivateRecord["kind"]) => rows.filter((row) => row.kind === kind);
  const paired = (row: PlainPrivateRecord, kind: PlainPrivateRecord["kind"]) => {
    const peer = byAddress.get(address({ kind, id: row.id }));
    if (!peer || peer.authorId !== row.authorId) throw new Error("Private view is missing a matching financial record");
    return value(peer);
  };
  return { check, visibility, value, ofKind, paired };
}
