import { mergeQuickStarts, quickStartKey, type DetailedFavorite, type DetailedEntry } from "@starter/core";
import type { BackgroundState, PopupToBackground } from "../lib/messaging";

/** Reapply in-flight edits over every worker snapshot, including background polls. */
export function optimisticState(
  state: BackgroundState,
  message: PopupToBackground,
  tempId: string,
  at: string = new Date().toISOString(),
): BackgroundState {
  switch (message.type) {
    case "timer:update": {
      if (state.running === null) return state;
      const { type: _type, ...patch } = message;
      return { ...state, running: { ...state.running, ...patch } };
    }
    case "favorite:add": {
      if (state.favorites.some((favorite) => quickStartKey(favorite) === quickStartKey(message.quick))) return state;
      const recent = state.recents.find((item) => quickStartKey(item) === quickStartKey(message.quick));
      const favorite: DetailedFavorite = {
        ...message.quick,
        id: tempId,
        workspaceId: state.activeWorkspaceId ?? "",
        userId: state.settings?.userId ?? "",
        order: state.favorites.length,
        createdAt: at,
        updatedAt: at,
        projectName: recent?.projectName ?? null,
        projectColor: recent?.projectColor ?? null,
        clientName: recent?.clientName ?? null,
        taskName: recent?.taskName ?? null,
        projectMissing: false,
        projectArchived: false,
        taskMissing: false,
      };
      const favorites = [...state.favorites, favorite];
      return { ...state, favorites, quickStarts: mergeQuickStarts({ favorites, recents: state.recents, limit: 6 }) };
    }
    case "favorite:remove": {
      const favorites = state.favorites.filter((favorite) => favorite.id !== message.id);
      return { ...state, favorites, quickStarts: mergeQuickStarts({ favorites, recents: state.recents, limit: 6 }) };
    }
    case "entry:update": {
      if (state.entries === null) return state;
      const { type: _type, ...patch } = message;
      const entries = state.entries.entries.map((entry): DetailedEntry => {
        if (entry.id !== message.id) return entry;
        const patched = { ...entry, ...patch };
        const start = patched.start;
        const end = patched.end;
        return {
          ...patched,
          durationSec: end === null ? entry.durationSec : Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)),
          projectName: state.projects.find((item) => item.id === patched.projectId)?.name ?? null,
          projectColor: state.projects.find((item) => item.id === patched.projectId)?.color ?? null,
          clientName: state.clients.find((item) => item.id === patched.clientId)?.name ?? null,
          taskName: state.tasks.find((item) => item.id === patched.taskId)?.name ?? null,
        };
      });
      return { ...state, entries: { ...state.entries, entries } };
    }
    case "client:update":
      return { ...state, clients: state.clients.map((row) => row.id === message.id ? { ...row, ...message.patch } : row) };
    case "project:update":
      return { ...state, projects: state.projects.map((row) => row.id === message.id ? { ...row, ...message.patch } : row) };
    case "task:update":
      return { ...state, tasks: state.tasks.map((row) => row.id === message.id ? { ...row, ...message.patch } : row) };
    case "tag:update":
      return { ...state, tags: state.tags.map((row) => row.id === message.id ? { ...row, ...message.patch } : row) };
    case "settings:update": {
      if (state.settings === null) return state;
      const settings = { ...state.settings } as Record<string, unknown>;
      for (const [key, value] of Object.entries(message.patch)) {
        const old = settings[key];
        settings[key] = value !== null && typeof value === "object" && !Array.isArray(value) &&
          old !== null && typeof old === "object" && !Array.isArray(old)
          ? { ...old, ...value }
          : value;
      }
      return { ...state, settings: settings as BackgroundState["settings"] };
    }
    case "device:revoke":
      return state.devices === null ? state : {
        ...state,
        devices: state.devices.filter((device) => device.id !== message.id),
      };
    case "devices:revoke-others":
      return state.devices === null ? state : {
        ...state,
        devices: state.devices.filter((device) => device.current),
      };
    default:
      return state;
  }
}

export const hasOptimisticState = (message: PopupToBackground): boolean =>
  ["timer:update", "favorite:add", "favorite:remove", "entry:update",
    "client:update", "project:update", "task:update", "tag:update", "settings:update",
    "device:revoke", "devices:revoke-others"].includes(message.type);
