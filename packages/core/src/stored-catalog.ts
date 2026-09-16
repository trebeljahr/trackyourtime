/**
 * Readers for catalog rows and settings a client cached on the device.
 *
 * Same contract as `stored-entry.ts`: check what the cache's readers actually
 * use — above all the rate and currency an optimistic entry's money is shaped
 * from — default what is only informational, and pass unknown fields through.
 * A row that fails is dropped on its own; settings that fail are "not loaded",
 * which the entry shapers already treat as a zero rate until the replay.
 */
import { z } from "zod";
import type {
  Client,
  DetailedFavorite,
  Project,
  ResolvedSettings,
  Tag,
  Task,
} from "@starter/shared";

/** A project as `projects.list` answers it, stats included. */
export type StoredProject = Project & {
  clientName: string | null;
  clientColor: string | null;
  entryCount: number;
  totalSec: number;
};

export type StoredTask = Task & { totalSec: number };

export type StoredTag = Tag & { entryCount: number; totalSec: number };

const id = z.string().min(1);
const nullableText = z.string().nullable().catch(null);
const count = z.number().min(0).catch(0);
const flag = z.boolean().catch(false);

const projectSchema = z.looseObject({
  id,
  name: z.string(),
  color: z.string(),
  clientId: z.string().nullable().catch(null),
  billableDefault: z.boolean(),
  hourlyRate: z.number().min(0).nullable(),
  archived: flag,
  clientName: nullableText,
  clientColor: nullableText,
  entryCount: count,
  totalSec: count,
});

const taskSchema = z.looseObject({
  id,
  name: z.string(),
  done: flag,
  archived: flag,
  totalSec: count,
});

const tagSchema = z.looseObject({
  id,
  name: z.string(),
  color: z.string(),
  archived: flag,
  entryCount: count,
  totalSec: count,
});

const clientSchema = z.looseObject({
  id,
  name: z.string(),
  color: z.string(),
  archived: flag,
});

const favoriteSchema = z.looseObject({
  id,
  description: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  billable: z.boolean(),
  order: z.number().catch(0),
  projectName: nullableText,
  projectColor: nullableText,
  clientName: nullableText,
  taskName: nullableText,
  projectMissing: flag,
  projectArchived: flag,
  taskMissing: flag,
});

/** Settings: only what money and identity are shaped from is required. */
const settingsSchema = z.looseObject({
  workspaceId: z.string(),
  userId: z.string(),
  currency: z.string().min(1),
  defaultHourlyRate: z.number().min(0),
});

const reader =
  <T>(schema: z.ZodType) =>
  (value: unknown): T | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as T) : null;
  };

export const readStoredProject = reader<StoredProject>(projectSchema);
export const readStoredTask = reader<StoredTask>(taskSchema);
export const readStoredTag = reader<StoredTag>(tagSchema);
export const readStoredClient = reader<Client>(clientSchema);
export const readStoredFavorite = reader<DetailedFavorite>(favoriteSchema);
export const readStoredSettings = reader<ResolvedSettings>(settingsSchema);
