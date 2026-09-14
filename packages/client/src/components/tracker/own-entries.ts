"use client";

import { isTempId } from "@starter/core";

import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";

/**
 * The tracker, the runaway guard and the calendar show the viewer's OWN time.
 *
 * `entries.list` answers with the whole workspace for somebody allowed to see
 * colleagues' time, and each of these screens would then do the wrong thing
 * with a colleague's row: the tracker would draw edit and delete controls
 * that `entries.update` rightly refuses, the runaway guard would ask "was this
 * timer really running for nine hours?" about somebody else's work, and the
 * calendar would let the viewer drag a colleague's block around. The team's
 * time belongs in Reports, which is built to show it.
 *
 * Two rows are always the viewer's own, whoever the list says wrote them:
 * a temp-id entry (created on this device and not yet sent, so its author is
 * whatever the optimistic shape could guess, possibly "") — and nothing else.
 * With no viewer id at all, only those survive: a list nobody can attribute
 * is not one to draw edit controls on.
 */
export const isOwnEntry = (
  entry: { id: string; authorId: string },
  viewerId: string | null
): boolean => isTempId(entry.id) || (viewerId !== null && entry.authorId === viewerId);

export const ownEntries = <E extends { id: string; authorId: string }>(
  entries: readonly E[],
  viewerId: string | null
): E[] => entries.filter((entry) => isOwnEntry(entry, viewerId));

/**
 * Who "own" means. The session first; `settings.get` (which carries `userId`
 * and which every screen already has cached through `useFormatSettings`) as
 * the fallback for the moment on the phone where the API answers with the
 * Keychain token before the session store has caught up — without it the
 * tracker would flash "no time tracked yet" on every native launch.
 */
export const useViewerId = (): string | null => {
  const { user } = useAuth();
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  return user?.id ?? settings.data?.userId ?? null;
};
