// The sync event union as a zod schema, for the contract snapshot only.
//
// `SyncEvent` in @starter/shared is a TypeScript type, and nothing validates a
// frame at runtime — clients cast. The contract still has to see which kinds
// and which payload enums a server can send, so this mirrors the type, and the
// two compile-time checks at the bottom keep the mirror exact in both
// directions: a kind added to `SyncEvent` and not here fails `tsc`.
import { z } from "zod";
import type { SyncEvent, TimeEntry } from "@starter/shared";

/**
 * An entry's own shape is not part of the event contract: it is the tRPC
 * output type, and outputs are not snapshotted. The title keeps the JSON
 * readable.
 */
const entry = z.custom<TimeEntry>().meta({ title: "TimeEntry" });

export const syncEventSchemas = {
  "entry.upserted": z.object({ kind: z.literal("entry.upserted"), entry }),
  "entry.deleted": z.object({ kind: z.literal("entry.deleted"), id: z.string() }),
  "timer.started": z.object({ kind: z.literal("timer.started"), entry }),
  "timer.stopped": z.object({ kind: z.literal("timer.stopped"), entry }),
  "catalog.changed": z.object({
    kind: z.literal("catalog.changed"),
    scope: z.enum(["client", "project", "task", "tag"]),
    entriesTouched: z.boolean().optional(),
  }),
  "favorites.changed": z.object({ kind: z.literal("favorites.changed") }),
  "invoice.changed": z.object({ kind: z.literal("invoice.changed"), id: z.string() }),
  "settings.changed": z.object({ kind: z.literal("settings.changed") }),
  "data.imported": z.object({
    kind: z.literal("data.imported"),
    batchId: z.string(),
    undone: z.boolean(),
  }),
  "integrations.changed": z.object({
    kind: z.literal("integrations.changed"),
    scope: z.enum(["api-token", "webhook"]),
  }),
  "membership.changed": z.object({
    kind: z.literal("membership.changed"),
    workspaceId: z.string(),
    reason: z.enum(["joined", "role", "visibility", "removed", "left", "transferred", "invitation"]),
  }),
} as const;

type Mirrored = z.infer<(typeof syncEventSchemas)[keyof typeof syncEventSchemas]>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Both directions: every mirrored event is a SyncEvent, and every SyncEvent is
// mirrored. `true` is the only value either constant can hold.
export const mirrorCoversSyncEvent: Exact<Mirrored, SyncEvent> = true;
export const mirrorKeysMatchKinds: Exact<keyof typeof syncEventSchemas, SyncEvent["kind"]> = true;
