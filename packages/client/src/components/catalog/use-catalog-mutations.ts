"use client";

import { createId } from "@starter/core";
import {
  EMPTY_ROLLUP,
  budgetProgress,
  hasBudgetTarget,
  rollupOf,
  type ProjectBudget,
} from "@starter/shared";

import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { intlLocale } from "@/i18n/format";
import { getActiveLocale } from "@/i18n/locale-store";
import { translate } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import {
  CLIENT_LIST_INPUT,
  PROJECT_LIST_INPUT,
  errorMessage,
  isConflict,
  sortByName,
  TASK_LIST_INPUT,
  type ClientRow,
  type CreatedClient,
  type CreatedProject,
  type CreatedTask,
  type CreateClientVars,
  type CreateProjectVars,
  type CreateTaskVars,
  type ProjectRow,
  type RemoveResult,
  type TaskRow,
  type UpdateClientVars,
  type UpdateProjectVars,
  type UpdateTaskVars,
  type UpdatedProject,
} from "./types";

/**
 * Forms pass `onConflict` so a duplicate name lands inline on the field
 * instead of in a toast. Everything else is surfaced as a toast.
 */
export type CatalogErrorHandlers = {
  onConflict?: (message: string) => void;
};

const DEFAULT_COLOR = "#4f46e5";

/**
 * Re-target a row's progress without re-reading its entries.
 *
 * Editing a budget changes only what the tracked time is compared against, so
 * the roll-up carries over untouched and the optimistic row shows the right
 * meter — including no meter at all when the target was just cleared.
 */
function retarget(row: ProjectRow, budget: ProjectBudget): ProjectRow["progress"] {
  if (!hasBudgetTarget(budget)) return null;
  return budgetProgress(
    budget,
    row.progress === null ? EMPTY_ROLLUP : rollupOf(row.progress),
  );
}

/** Which catalog resource a message is about; an ICU `select` in the catalog. */
export type CatalogKind = "client" | "project" | "task" | "tag";

/**
 * A refused write, as a toast or — for a duplicate name — inline on the field.
 *
 * The server's CONFLICT message is English; the name the user typed is all a
 * localised one needs, so it is rebuilt here when the name is known.
 */
function reportError(
  error: unknown,
  fallback: string,
  handlers: CatalogErrorHandlers,
  conflict?: { kind: CatalogKind; name: string | undefined },
): void {
  if (isConflict(error)) {
    const message =
      conflict?.name === undefined
        ? errorMessage(error, fallback)
        : translate("catalog")("errors.nameTaken", {
            kind: conflict.kind,
            name: conflict.name.trim(),
          });
    if (handlers.onConflict) {
      handlers.onConflict(message);
      return;
    }
    toast.error(message);
    return;
  }
  toast.error(errorMessage(error, fallback));
}

/**
 * Deletion always succeeds now, so the toast reports the collateral rather
 * than the outcome: what was deleted alongside it, and what merely lost a
 * reference. Tracked time is never among the casualties.
 */
function announceRemoval(
  result: RemoveResult,
  kind: Exclude<CatalogKind, "tag">,
): void {
  const t = translate("catalog");
  const detail: string[] = [];
  if (result.tasksDeleted > 0) {
    detail.push(t("removal.tasksDeleted", { count: result.tasksDeleted }));
  }
  if (result.projectsDetached > 0) {
    detail.push(
      t("removal.projectsDetached", { count: result.projectsDetached }),
    );
  }
  if (result.entriesDetached > 0) {
    detail.push(
      t("removal.entriesDetached", { count: result.entriesDetached, kind }),
    );
  }
  if (result.favoritesDetached > 0) {
    detail.push(
      t("removal.favoritesDetached", { count: result.favoritesDetached, kind }),
    );
  }

  // A unit list is a plain comma series ("a, b, c") in English, and follows
  // each language's own punctuation elsewhere.
  const list = new Intl.ListFormat(intlLocale(getActiveLocale()), {
    type: "unit",
    style: "short",
  });
  toast.success(
    detail.length === 0
      ? t("removal.deleted", { kind })
      : t("removal.deletedWithDetail", { kind, detail: list.format(detail) }),
  );
}

// ── projects ─────────────────────────────────────────────────────────

export type ProjectMutations = {
  /** Resolves to the created project, or null when the server refused. */
  createProject: (vars: CreateProjectVars) => Promise<CreatedProject | null>;
  /**
   * With `applyToEntries`, the project's billing is also written onto the
   * caller's un-invoiced entries on it — see `apply-to-entries-prompt.tsx`.
   */
  updateProject: (vars: UpdateProjectVars) => Promise<UpdatedProject | null>;
  setProjectArchived: (id: string, archived: boolean) => void;
  removeProject: (id: string) => void;
  isSaving: boolean;
};

export function useProjectMutations(
  handlers: CatalogErrorHandlers = {},
): ProjectMutations {
  const utils = trpc.useUtils();

  const findClient = (id: string | null | undefined): ClientRow | null => {
    if (!id) return null;
    const clients = utils.clients.list.getData(CLIENT_LIST_INPUT) ?? [];
    return clients.find((client) => client.id === id) ?? null;
  };

  const writeProjects = (
    update: (rows: ProjectRow[]) => ProjectRow[],
  ): void => {
    utils.projects.list.setData(PROJECT_LIST_INPUT, (old) =>
      old === undefined ? old : update(old),
    );
  };

  const beginProjectWrite = async (): Promise<{
    previous: ProjectRow[] | undefined;
  }> => {
    await utils.projects.list.cancel(PROJECT_LIST_INPUT);
    return { previous: utils.projects.list.getData(PROJECT_LIST_INPUT) };
  };

  const rollbackProjects = (previous: ProjectRow[] | undefined): void => {
    if (previous !== undefined) {
      utils.projects.list.setData(PROJECT_LIST_INPUT, previous);
    }
  };

  const settleProjects = (): void => {
    void utils.projects.list.invalidate();
  };

  const create = trpc.projects.create.useMutation({
    onMutate: async (vars) => {
      const context = await beginProjectWrite();
      const now = new Date().toISOString();
      const client = findClient(vars.clientId);
      const budget: ProjectBudget = {
        estimatedHours: vars.estimatedHours ?? null,
        budgetAmount: vars.budgetAmount ?? null,
        // The server snapshots the workspace currency; the refetch replaces
        // this guess with whatever it actually stored.
        budgetCurrency:
          vars.budgetAmount === undefined || vars.budgetAmount === null
            ? null
            : (vars.budgetCurrency ?? null),
      };
      const optimistic: ProjectRow = {
        id: `optimistic-${createId()}`,
        workspaceId: "",
        createdBy: "",
        name: vars.name.trim(),
        color: vars.color ?? DEFAULT_COLOR,
        clientId: vars.clientId ?? null,
        billableDefault: vars.billableDefault ?? true,
        hourlyRate: vars.hourlyRate ?? null,
        estimatedHours: budget.estimatedHours,
        budgetAmount: budget.budgetAmount,
        budgetCurrency: budget.budgetCurrency,
        idleBehavior: vars.idleBehavior ?? null,
        archived: false,
        createdAt: now,
        updatedAt: now,
        clientName: client?.name ?? null,
        clientColor: client?.color ?? null,
        entryCount: 0,
        totalSec: 0,
        // A brand-new project has tracked nothing, so its progress is its
        // target and zero spend — never a stale roll-up.
        progress: hasBudgetTarget(budget)
          ? budgetProgress(budget, EMPTY_ROLLUP)
          : null,
      };
      writeProjects((rows) => sortByName([...rows, optimistic]));
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackProjects(context?.previous);
      reportError(error, translate("catalog")("errors.createProject"), handlers, {
        kind: "project",
        name: _vars.name,
      });
    },
    onSettled: settleProjects,
  });

  const update = trpc.projects.update.useMutation({
    onMutate: async (vars) => {
      const context = await beginProjectWrite();
      const client =
        vars.clientId === undefined ? undefined : findClient(vars.clientId);
      writeProjects((rows) =>
        sortByName(
          rows.map((row) => {
            if (row.id !== vars.id) return row;
            const budget: ProjectBudget = {
              estimatedHours:
                vars.estimatedHours === undefined
                  ? row.estimatedHours
                  : (vars.estimatedHours ?? null),
              budgetAmount:
                vars.budgetAmount === undefined
                  ? row.budgetAmount
                  : (vars.budgetAmount ?? null),
              budgetCurrency:
                vars.budgetAmount === null
                  ? null
                  : (vars.budgetCurrency ?? row.budgetCurrency),
            };
            return {
              ...row,
              ...budget,
              progress: retarget(row, budget),
              ...(vars.name !== undefined ? { name: vars.name.trim() } : {}),
              ...(vars.color !== undefined ? { color: vars.color } : {}),
              ...(vars.clientId !== undefined
                ? {
                    clientId: vars.clientId ?? null,
                    clientName: client?.name ?? null,
                    clientColor: client?.color ?? null,
                  }
                : {}),
              ...(vars.billableDefault !== undefined
                ? { billableDefault: vars.billableDefault }
                : {}),
              ...(vars.hourlyRate !== undefined
                ? { hourlyRate: vars.hourlyRate ?? null }
                : {}),
              ...(vars.idleBehavior !== undefined
                ? { idleBehavior: vars.idleBehavior ?? null }
                : {}),
              ...(vars.archived !== undefined
                ? { archived: vars.archived }
                : {}),
            };
          }),
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackProjects(context?.previous);
      reportError(error, translate("catalog")("errors.saveProject"), handlers, {
        kind: "project",
        name: _vars.name,
      });
    },
    // A rewrite moves every entry-backed number: the entry lists, report
    // totals and the invoice preview's billable time.
    onSettled: (_data, _error, vars) => {
      settleProjects();
      if (vars.applyToEntries) {
        void utils.projects.billingImpact.invalidate();
        void utils.entries.invalidate();
        void utils.reports.invalidate();
        void utils.invoices.invalidate();
      }
    },
  });

  const archive = trpc.projects.archive.useMutation({
    onMutate: async (vars) => {
      const context = await beginProjectWrite();
      writeProjects((rows) =>
        rows.map((row) =>
          row.id === vars.id
            ? { ...row, archived: vars.archived ?? true }
            : row,
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackProjects(context?.previous);
      reportError(error, translate("catalog")("errors.archiveProject"), handlers);
    },
    onSettled: settleProjects,
  });

  const remove = trpc.projects.remove.useMutation({
    onMutate: async (vars) => {
      const context = await beginProjectWrite();
      writeProjects((rows) => rows.filter((row) => row.id !== vars.id));
      return context;
    },
    onSuccess: (result) => {
      announceRemoval(result, "project");
    },
    onError: (error, _vars, context) => {
      rollbackProjects(context?.previous);
      reportError(error, translate("catalog")("errors.deleteProject"), handlers);
    },
    // The cascade drops the project's tasks and detaches its entries, so the
    // entry-backed caches are stale too.
    onSettled: () => {
      settleProjects();
      void utils.tasks.list.invalidate();
      void utils.entries.invalidate();
      void utils.reports.invalidate();
    },
  });

  return {
    createProject: (vars) =>
      create.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    updateProject: (vars) =>
      update.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    setProjectArchived: (id, archived) => {
      archive.mutate({ id, archived, originId: ORIGIN_ID });
    },
    removeProject: (id) => {
      remove.mutate({ id, originId: ORIGIN_ID });
    },
    isSaving: create.isPending || update.isPending,
  };
}

// ── clients ──────────────────────────────────────────────────────────

export type ClientMutations = {
  createClient: (vars: CreateClientVars) => Promise<CreatedClient | null>;
  updateClient: (vars: UpdateClientVars) => Promise<CreatedClient | null>;
  setClientArchived: (id: string, archived: boolean) => void;
  removeClient: (id: string) => void;
  isSaving: boolean;
};

export function useClientMutations(
  handlers: CatalogErrorHandlers = {},
): ClientMutations {
  const utils = trpc.useUtils();

  const writeClients = (update: (rows: ClientRow[]) => ClientRow[]): void => {
    utils.clients.list.setData(CLIENT_LIST_INPUT, (old) =>
      old === undefined ? old : update(old),
    );
  };

  const beginClientWrite = async (): Promise<{
    previous: ClientRow[] | undefined;
  }> => {
    await utils.clients.list.cancel(CLIENT_LIST_INPUT);
    return { previous: utils.clients.list.getData(CLIENT_LIST_INPUT) };
  };

  const rollbackClients = (previous: ClientRow[] | undefined): void => {
    if (previous !== undefined) {
      utils.clients.list.setData(CLIENT_LIST_INPUT, previous);
    }
  };

  // Projects denormalize the client name/colour, so they refresh too.
  const settleClients = (): void => {
    void utils.clients.list.invalidate();
    void utils.projects.list.invalidate();
  };

  const create = trpc.clients.create.useMutation({
    onMutate: async (vars) => {
      const context = await beginClientWrite();
      const now = new Date().toISOString();
      const optimistic: ClientRow = {
        id: `optimistic-${createId()}`,
        workspaceId: "",
        createdBy: "",
        name: vars.name.trim(),
        color: vars.color ?? DEFAULT_COLOR,
        archived: false,
        invoiceLocale: vars.invoiceLocale ?? null,
        createdAt: now,
        updatedAt: now,
      };
      writeClients((rows) => sortByName([...rows, optimistic]));
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackClients(context?.previous);
      reportError(error, translate("catalog")("errors.createClient"), handlers, {
        kind: "client",
        name: _vars.name,
      });
    },
    onSettled: settleClients,
  });

  const update = trpc.clients.update.useMutation({
    onMutate: async (vars) => {
      const context = await beginClientWrite();
      writeClients((rows) =>
        sortByName(
          rows.map((row) =>
            row.id === vars.id
              ? {
                  ...row,
                  ...(vars.name !== undefined
                    ? { name: vars.name.trim() }
                    : {}),
                  ...(vars.color !== undefined ? { color: vars.color } : {}),
                  ...(vars.archived !== undefined
                    ? { archived: vars.archived }
                    : {}),
                  ...(vars.invoiceLocale !== undefined
                    ? { invoiceLocale: vars.invoiceLocale }
                    : {}),
                }
              : row,
          ),
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackClients(context?.previous);
      reportError(error, translate("catalog")("errors.saveClient"), handlers, {
        kind: "client",
        name: _vars.name,
      });
    },
    onSettled: settleClients,
  });

  const archive = trpc.clients.archive.useMutation({
    onMutate: async (vars) => {
      const context = await beginClientWrite();
      writeClients((rows) =>
        rows.map((row) =>
          row.id === vars.id ? { ...row, archived: vars.archived ?? true } : row,
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackClients(context?.previous);
      reportError(error, translate("catalog")("errors.archiveClient"), handlers);
    },
    onSettled: settleClients,
  });

  const remove = trpc.clients.remove.useMutation({
    onMutate: async (vars) => {
      const context = await beginClientWrite();
      writeClients((rows) => rows.filter((row) => row.id !== vars.id));
      return context;
    },
    onSuccess: (result) => {
      announceRemoval(result, "client");
    },
    onError: (error, _vars, context) => {
      rollbackClients(context?.previous);
      reportError(error, translate("catalog")("errors.deleteClient"), handlers);
    },
    onSettled: settleClients,
  });

  return {
    createClient: (vars) =>
      create.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    updateClient: (vars) =>
      update.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    setClientArchived: (id, archived) => {
      archive.mutate({ id, archived, originId: ORIGIN_ID });
    },
    removeClient: (id) => {
      remove.mutate({ id, originId: ORIGIN_ID });
    },
    isSaving: create.isPending || update.isPending,
  };
}

// ── tasks ────────────────────────────────────────────────────────────

export type TaskMutations = {
  createTask: (vars: CreateTaskVars) => Promise<CreatedTask | null>;
  updateTask: (vars: UpdateTaskVars) => Promise<CreatedTask | null>;
  setTaskArchived: (id: string, archived: boolean) => void;
  removeTask: (id: string) => void;
  isSaving: boolean;
};

/**
 * Tasks are a flat, workspace-wide catalog, so there is exactly one listing to
 * write optimistically and one cache key to invalidate.
 */
export function useTaskMutations(
  handlers: CatalogErrorHandlers = {},
): TaskMutations {
  const utils = trpc.useUtils();
  const input = TASK_LIST_INPUT;

  const writeTasks = (update: (rows: TaskRow[]) => TaskRow[]): void => {
    utils.tasks.list.setData(input, (old) =>
      old === undefined ? old : update(old),
    );
  };

  const beginTaskWrite = async (): Promise<{
    previous: TaskRow[] | undefined;
  }> => {
    await utils.tasks.list.cancel(input);
    return { previous: utils.tasks.list.getData(input) };
  };

  const rollbackTasks = (previous: TaskRow[] | undefined): void => {
    if (previous !== undefined) utils.tasks.list.setData(input, previous);
  };

  const settleTasks = (): void => {
    void utils.tasks.list.invalidate();
  };

  const create = trpc.tasks.create.useMutation({
    onMutate: async (vars) => {
      const context = await beginTaskWrite();
      const now = new Date().toISOString();
      const optimistic: TaskRow = {
        id: `optimistic-${createId()}`,
        workspaceId: "",
        createdBy: "",
        name: vars.name.trim(),
        color: vars.color ?? DEFAULT_COLOR,
        archived: false,
        createdAt: now,
        updatedAt: now,
        entryCount: 0,
        totalSec: 0,
        projectIds: [],
      };
      writeTasks((rows) => sortByName([...rows, optimistic]));
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackTasks(context?.previous);
      reportError(error, translate("catalog")("errors.createTask"), handlers, {
        kind: "task",
        name: _vars.name,
      });
    },
    onSettled: settleTasks,
  });

  const update = trpc.tasks.update.useMutation({
    onMutate: async (vars) => {
      const context = await beginTaskWrite();
      writeTasks((rows) =>
        sortByName(
          rows.map((row) =>
            row.id === vars.id
              ? {
                  ...row,
                  ...(vars.name !== undefined
                    ? { name: vars.name.trim() }
                    : {}),
                  ...(vars.color !== undefined ? { color: vars.color } : {}),
                  ...(vars.archived !== undefined
                    ? { archived: vars.archived }
                    : {}),
                }
              : row,
          ),
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackTasks(context?.previous);
      reportError(error, translate("catalog")("errors.saveTask"), handlers, {
        kind: "task",
        name: _vars.name,
      });
    },
    onSettled: settleTasks,
  });

  const archive = trpc.tasks.archive.useMutation({
    onMutate: async (vars) => {
      const context = await beginTaskWrite();
      writeTasks((rows) =>
        rows.map((row) =>
          row.id === vars.id ? { ...row, archived: vars.archived ?? true } : row,
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollbackTasks(context?.previous);
      reportError(error, translate("catalog")("errors.archiveTask"), handlers);
    },
    onSettled: settleTasks,
  });

  const remove = trpc.tasks.remove.useMutation({
    onMutate: async (vars) => {
      const context = await beginTaskWrite();
      writeTasks((rows) => rows.filter((row) => row.id !== vars.id));
      return context;
    },
    onSuccess: (result) => {
      announceRemoval(result, "task");
    },
    onError: (error, _vars, context) => {
      rollbackTasks(context?.previous);
      reportError(error, translate("catalog")("errors.deleteTask"), handlers);
    },
    // Deleting a task detaches the entries booked on it.
    onSettled: () => {
      settleTasks();
      void utils.entries.invalidate();
      void utils.reports.invalidate();
    },
  });

  return {
    createTask: (vars) =>
      create.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    updateTask: (vars) =>
      update.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    setTaskArchived: (id, archived) => {
      archive.mutate({ id, archived, originId: ORIGIN_ID });
    },
    removeTask: (id) => {
      remove.mutate({ id, originId: ORIGIN_ID });
    },
    isSaving: create.isPending || update.isPending,
  };
}
