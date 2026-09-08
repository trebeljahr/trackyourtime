"use client";

import * as React from "react";
import { UserRoundX } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";
import {
  discardForeignQueued,
  listForeignQueued,
  type ForeignQueuedRow,
} from "@/lib/offline";

/**
 * Unsynced work left on this device by an account that is not signed in.
 *
 * The queue outlives a sign-out on purpose — those rows are time no server has
 * ever seen — and they are never replayed under a different account, which
 * would file somebody's work into the wrong workspace. Both of those are
 * right, and together they make the rows immortal: without this panel the
 * tracker shows a count nobody can act on, forever, and only a reinstall
 * clears it.
 *
 * So: a place to look at them, and one deliberate way out. No age-based
 * expiry — deleting somebody's tracked time on a timer is still deleting it
 * silently, which is the thing this whole mechanism exists to avoid.
 */

const OP_LABELS: Record<string, string> = {
  "entries.start": "Started a timer",
  "entries.stop": "Stopped a timer",
  "entries.create": "Logged time",
  "entries.update": "Edited an entry",
  "entries.remove": "Deleted an entry",
  "entries.discard": "Discarded a timer",
};

const label = (row: ForeignQueuedRow): string =>
  row.op === null ? "Unrecognised change" : (OP_LABELS[row.op] ?? row.op);

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatAt = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "Unknown time" : dateFormatter.format(at);
};

/** "21 Aug" or "21–22 Aug" — enough to recognise, short enough for a sentence. */
const formatRange = (rows: ForeignQueuedRow[]): string | null => {
  const times = rows
    .map((row) => new Date(row.at).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b);
  if (times.length === 0) return null;

  const short = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });
  const first = short.format(new Date(times[0]));
  const last = short.format(new Date(times[times.length - 1]));
  return first === last ? first : `${first} – ${last}`;
};

export function ForeignQueuePanel(): React.JSX.Element | null {
  const { foreign } = useOfflineQueueState();
  const [rows, setRows] = React.useState<ForeignQueuedRow[]>([]);
  const [confirming, setConfirming] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);

  // Keyed on the count rather than read once: a flush, a sign-in or a discard
  // all change it, and the provider's store is what notices.
  React.useEffect(() => {
    let cancelled = false;
    void listForeignQueued().then((next) => {
      if (!cancelled) setRows(next);
    });
    return () => {
      cancelled = true;
    };
  }, [foreign]);

  // Nothing to say when the device is holding nobody else's work, and a card
  // that permanently reports "none" is noise on a screen that already has a
  // lot of it.
  if (foreign === 0) return null;

  const range = formatRange(rows);

  const discard = async (): Promise<void> => {
    setDiscarding(true);
    try {
      const removed = await discardForeignQueued();
      setConfirming(false);
      toast.success(
        removed === 1
          ? "Discarded 1 unsynced change"
          : `Discarded ${removed} unsynced changes`,
      );
    } catch {
      toast.error("Could not discard those changes");
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <Card data-testid="foreign-queue-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRoundX className="size-4" />
          Unsynced data from another account
        </CardTitle>
        <CardDescription>
          {foreign} change{foreign === 1 ? "" : "s"} queued on this device by an
          account that is not signed in
          {range ? `, from ${range}` : ""}. They were never sent to a server,
          and they are not replayed under your account — that would file
          somebody else&apos;s work into your workspace. Sign in as that account
          on this device to sync them, or discard them here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1 text-sm" data-testid="foreign-queue-rows">
          {rows.map((row) => (
            <li
              key={row.queueId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 border-b py-1 last:border-b-0"
            >
              <span>
                {label(row)}
                {row.description ? (
                  <span className="text-muted-foreground">
                    {" — "}
                    {row.description}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatAt(row.at)}
              </span>
            </li>
          ))}
        </ul>

        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          data-testid="foreign-queue-discard"
        >
          Discard {foreign} change{foreign === 1 ? "" : "s"}
        </Button>
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent data-testid="foreign-queue-confirm">
          <DialogHeader>
            <DialogTitle>
              Discard {foreign} unsynced change{foreign === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This deletes work tracked{range ? ` on ${range}` : ""} that no
              server has ever received. It cannot be recovered — not by that
              account signing in here, and not from a backup. Sign in as that
              account on this device instead if it should be kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirming(false)}
              data-testid="foreign-queue-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={discarding}
              onClick={() => void discard()}
              data-testid="foreign-queue-confirm-discard"
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
