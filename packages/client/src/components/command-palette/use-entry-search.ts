"use client";

import * as React from "react";
import type { DetailedEntry, EntryListInput } from "@starter/shared";

export type EntrySearchScope = { userId: string; workspaceId: string; server: string };
export type EntrySearchState = { key: string; status: "loading" | "ready" | "error"; entries: DetailedEntry[]; more: boolean };
export type FetchEntrySearch = (input: EntryListInput & { workspaceId: string }, signal: AbortSignal) => Promise<{ entries: DetailedEntry[]; nextCursor?: string }>;
export const entrySearchKey = (scope: EntrySearchScope | null, search: string): string => JSON.stringify([scope?.server, scope?.userId, scope?.workspaceId, search.trim()]);

/** Local results never enter an account-agnostic React Query cache. */
export function useEntrySearch(search: string, scope: EntrySearchScope | null, fetchEntries: FetchEntrySearch): EntrySearchState & { retry: () => void } {
  const query = search.trim().slice(0, 200);
  const key = entrySearchKey(scope, query);
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<EntrySearchState>({ key: "", status: "loading", entries: [], more: false });
  const userId = scope?.userId;
  const workspaceId = scope?.workspaceId;
  const server = scope?.server;
  React.useEffect(() => {
    if (!query || !userId || !workspaceId || !server) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ key, status: "loading", entries: [], more: false });
      const input = { workspaceId, from: "1970-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z", search: query, limit: 10 };
      void fetchEntries(input, controller.signal).then((answer) => {
        if (controller.signal.aborted) return;
        setState({ key, status: "ready", entries: answer.entries.filter((entry) => entry.workspaceId === workspaceId).slice(0, 10), more: Boolean(answer.nextCursor) });
      }).catch(() => {
        if (!controller.signal.aborted) setState({ key, status: "error", entries: [], more: false });
      });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, query, userId, workspaceId, server, attempt, fetchEntries]);
  const visible = state.key === key ? state : { key, status: "loading" as const, entries: [], more: false };
  return { ...visible, retry: () => setAttempt((value) => value + 1) };
}
