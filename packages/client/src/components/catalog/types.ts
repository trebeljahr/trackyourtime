import type {
  BudgetProgress,
  Client,
  CreateClientInput,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectUpdateResult,
  Task,
  UpdateClientInput,
  UpdateProjectWithEntriesInput,
  UpdateTaskInput,
} from "@starter/shared";
import { userErrorMessage } from "@/lib/error-message";

// The router's own output types live behind `@starter/server/trpc`, which
// only re-exports `AppRouter`; `inferRouterOutputs` would need `@trpc/server`
// as a client dependency. These mirror the catalog routers' return shapes
// structurally instead, so `setData` still type-checks against the cache.

/** A project joined with its client and rolled-up time totals. */
export type ProjectRow = Project & {
  clientName: string | null;
  clientColor: string | null;
  /** Number of time entries booked on this project. */
  entryCount: number;
  /** Sum of `durationSec` across those entries. */
  totalSec: number;
  /**
   * Lifetime progress against the estimate/budget, or null when the project
   * has neither. Null is what makes an empty budget cell possible — a project
   * without a target must never render as "0% of 0".
   */
  progress: BudgetProgress | null;
};

/** A bare client, as returned by `clients.list`. */
export type ClientRow = Client;

/** A task plus its tracked seconds and the projects it has been booked on. */
export type TaskRow = Task & {
  totalSec: number;
  projectIds: string[];
};

/**
 * What every catalog `remove` resolves to. Deletion always happens — the
 * counts describe what the cascade detached on the way.
 */
export type RemoveResult = {
  entriesDetached: number;
  tasksDeleted: number;
  projectsDetached: number;
  favoritesDetached: number;
};

// Mutation results are the bare documents — no joins, no rolled-up totals.
export type CreatedProject = Project;
/** `projects.update`, plus what an `applyToEntries` rewrite reached. */
export type UpdatedProject = ProjectUpdateResult;
export type CreatedClient = Client;
export type CreatedTask = Task;

// `originId` is stamped by the mutation hooks, never by a caller.
export type CreateProjectVars = Omit<CreateProjectInput, "originId">;
export type UpdateProjectVars = Omit<UpdateProjectWithEntriesInput, "originId">;
export type CreateClientVars = Omit<CreateClientInput, "originId">;
export type UpdateClientVars = Omit<UpdateClientInput, "originId">;
export type CreateTaskVars = Omit<CreateTaskInput, "originId">;
export type UpdateTaskVars = Omit<UpdateTaskInput, "originId">;

/**
 * The catalog screen always asks for everything (archived included) and
 * filters in the browser. One canonical cache key per resource keeps the
 * optimistic `setData` calls deterministic — no key has to be guessed from
 * whatever filter the user happens to have toggled.
 */
export const PROJECT_LIST_INPUT: { includeArchived: boolean } = {
  includeArchived: true,
};

export const CLIENT_LIST_INPUT: { includeArchived: boolean } = {
  includeArchived: true,
};

/**
 * Tasks are workspace-wide, so there is one listing and one cache key for it.
 */
export const TASK_LIST_INPUT: { includeArchived: boolean } = {
  includeArchived: true,
};

/** Mirrors the server's case-insensitive name sort. */
export function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** tRPC error codes arrive on `error.data.code`; narrow without `any`. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The server's message, or `fallback` — see `userErrorMessage`. */
export function errorMessage(error: unknown, fallback: string): string {
  return userErrorMessage(error, fallback);
}

/** Duplicate names come back as CONFLICT and belong inline on the field. */
export function isConflict(error: unknown): boolean {
  return errorCode(error) === "CONFLICT";
}
