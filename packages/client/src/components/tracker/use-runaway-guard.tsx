"use client";

import * as React from "react";
import { toast } from "sonner";
import type { RunawayMark, TimeEntry } from "@starter/shared";

import { RunawayPrompt, type RunawayAnswer } from "@/components/tracker/runaway-prompt";
import {
  TRACKER_LIST_INPUT,
  type EntryMutations,
} from "@/components/tracker/use-entry-mutations";
import { notifyDesktop } from "@/lib/desktop-shell";
import { formatDurationShortFor } from "@/i18n/format";
import { getActiveLocale } from "@/i18n/locale-store";
import { translate } from "@/i18n/translate";
import { trpc } from "@/lib/trpc";
import { isOwnEntry, useViewerId } from "@/components/tracker/own-entries";

/** Prefix keeps one toast per entry, so a re-render never stacks duplicates. */
const toastId = (entryId: string): string => `runaway:${entryId}`;

type Marked = { entry: TimeEntry; mark: RunawayMark };

/**
 * Surface the runaway-timer guard's verdict and let the person answer it.
 *
 * The guard itself runs on the server — see `services/runaway.ts` for why it
 * cannot live in a client. This hook is only the mouth: it watches the entry
 * list for a mark the person has not answered yet, and raises the same kind of
 * prompt the idle and sub-minute cases raise.
 *
 * It reads the LIST rather than `entries.current`, because a marked entry is
 * often no longer the running one: the `cap` and `stop` behaviours both end
 * it. Watching only the running entry would show the prompt for the behaviour
 * that changes nothing and hide it for the two that do.
 *
 * The query here is the same react-query subscription the entry list already
 * holds, so this costs no extra request.
 */
export const useRunawayGuard = (mutations: EntryMutations): void => {
  const query = trpc.entries.list.useInfiniteQuery(TRACKER_LIST_INPUT, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchOnWindowFocus: true,
  });

  // A colleague's runaway timer is theirs to answer, not the viewer's — and
  // `entries.resolveRunaway` would refuse the answer anyway.
  const viewerId = useViewerId();
  const marked: Marked[] = React.useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages
      .flatMap((page) => page.entries)
      .flatMap((entry) =>
        isOwnEntry(entry, viewerId) &&
        entry.runaway &&
        entry.runaway.resolvedAt === null
          ? [{ entry: entry as TimeEntry, mark: entry.runaway }]
          : [],
      );
  }, [query.data, viewerId]);

  const { resolveRunaway } = mutations;

  // A ref, not state: the answer handler must reach the newest `resolve`
  // without re-rendering — and therefore re-raising — a toast that is already
  // on screen waiting to be answered.
  const resolveRef = React.useRef(resolveRunaway);
  React.useEffect(() => {
    resolveRef.current = resolveRunaway;
  }, [resolveRunaway]);

  // Everything already shown, so a list refetch does not re-raise a prompt the
  // person is in the middle of reading.
  const shown = React.useRef(new Set<string>());

  React.useEffect(() => {
    const live = new Set(marked.map((it) => it.entry.id));
    for (const id of shown.current) {
      // Answered, deleted, or resolved on another device — take the prompt
      // down rather than leaving a decision on screen that no longer exists.
      if (!live.has(id)) {
        toast.dismiss(toastId(id));
        shown.current.delete(id);
      }
    }

    for (const { entry, mark } of marked) {
      if (shown.current.has(entry.id)) continue;
      shown.current.add(entry.id);

      toast.custom(
        () => (
          <RunawayPrompt
            entry={entry}
            mark={mark}
            onAnswer={(answer: RunawayAnswer) => {
              toast.dismiss(toastId(entry.id));
              resolveRef.current({ id: entry.id, ...answer });
            }}
          />
        ),
        {
          id: toastId(entry.id),
          // No auto-dismiss: this is a question about hours of someone's work,
          // and a prompt that vanishes on its own is a prompt that silently
          // accepts whatever the guard already did.
          duration: Infinity,
        },
      );

      // Only the flag that is still a question about a running timer; `cap`
      // and `stop` already acted, and their prompt can wait for the window.
      if (mark.action === "flagged") {
        const tr = translate("tracker");
        const description = entry.description.trim();
        notifyDesktop({
          kind: "runaway",
          tag: toastId(entry.id),
          title: tr("desktopNotice.runawayTitle", {
            ran: formatDurationShortFor(mark.elapsedSec, getActiveLocale()),
          }),
          body:
            description === ""
              ? tr("desktopNotice.runawayBodyNoDescription")
              : tr("desktopNotice.runawayBody", { description }),
        });
      }
    }
  }, [marked]);
};
