"use client";

import * as React from "react";
import { Building2, ServerOff, UserRoundX } from "lucide-react";
import { serverLabel } from "@starter/core";

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
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { useT } from "@/i18n/use-t";

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
 *
 * The same holds for rows queued against another SERVER, which the phone apps
 * keep when the person points them somewhere else. They are grouped per server
 * and per "another account", because the way to keep each is different — sign
 * in as that account, or switch back to that server — and one "discard all"
 * would make a person decide about both at once.
 *
 * And for rows this account queued in a workspace it no longer belongs to —
 * removed, or left on another device. Those are held rather than sent
 * anywhere (`lib/offline.ts`), grouped per workspace, and named: by the
 * workspace's name while the list still knows it, else as "a workspace you
 * left". The way to keep them is different again — be added back — so they
 * get their own group and their own confirmation.
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

type Group = {
  /** The server the rows belong to, or null for rows on this one. */
  server: string | null;
  /**
   * Set for this account's rows in a workspace it left: that workspace's id
   * and, while the list still knows it, its name.
   */
  workspace: { id: string; name: string | null } | null;
  rows: ForeignQueuedRow[];
};

const groupKey = (row: ForeignQueuedRow): string => {
  if (row.otherServer !== null) return `server:${row.otherServer}`;
  if (row.leftWorkspace) return `workspace:${row.workspaceId ?? ""}`;
  return "account";
};

/** Another account on this server first, then left workspaces, then servers. */
const groupRank = (group: Group): number =>
  group.server !== null ? 2 : group.workspace !== null ? 1 : 0;

const groupRows = (rows: ForeignQueuedRow[]): Group[] => {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? {
      server: row.otherServer,
      workspace:
        row.otherServer === null && row.leftWorkspace
          ? { id: row.workspaceId ?? "", name: row.workspaceName }
          : null,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  // Another account on this server first: it is the one the tracker bar's
  // badge most often means.
  return [...groups.values()].sort((a, b) => groupRank(a) - groupRank(b));
};

const changes = (count: number): string =>
  `${count} change${count === 1 ? "" : "s"}`;

export function ForeignQueuePanel(): React.JSX.Element | null {
  const { foreign } = useOfflineQueueState();
  const t = useT("settings");
  const [rows, setRows] = React.useState<ForeignQueuedRow[]>([]);
  const [confirming, setConfirming] = React.useState<Group | null>(null);
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

  const groups = groupRows(rows);
  const here = serverLabel(getAbsoluteApiOrigin());

  const discard = async (group: Group): Promise<void> => {
    setDiscarding(true);
    try {
      const removed = await discardForeignQueued(
        group.rows.map((row) => row.queueId),
      );
      setConfirming(null);
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

  const confirmRange = confirming ? formatRange(confirming.rows) : null;
  const workspaceLabel = (workspace: { name: string | null }): string =>
    workspace.name ?? t("foreignQueue.leftWorkspace");

  return (
    <Card data-testid="foreign-queue-panel">
      {groups.length === 0 ? (
        // The count arrived before the rows did.
        <CardHeader>
          <CardTitle>Unsynced data on this device</CardTitle>
          <CardDescription>
            {changes(foreign)} queued on this device cannot be sent from here.
          </CardDescription>
        </CardHeader>
      ) : null}

      {groups.map((group) => {
        const range = formatRange(group.rows);
        const count = group.rows.length;
        const there = group.server === null ? null : serverLabel(group.server);
        return (
          <div
            key={
              group.server ??
              (group.workspace === null ? "account" : `workspace:${group.workspace.id}`)
            }
            className="border-b last:border-b-0"
            data-testid="foreign-queue-group"
            data-server={group.server ?? ""}
            data-workspace-id={group.workspace?.id ?? ""}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {group.workspace !== null ? (
                  <>
                    <Building2 className="size-4" />
                    {t("foreignQueue.leftTitle", {
                      workspace: workspaceLabel(group.workspace),
                    })}
                  </>
                ) : there === null ? (
                  <>
                    <UserRoundX className="size-4" />
                    Unsynced data from another account
                  </>
                ) : (
                  <>
                    <ServerOff className="size-4" />
                    Unsynced data for {there}
                  </>
                )}
              </CardTitle>
              <CardDescription>
                {group.workspace !== null ? (
                  t("foreignQueue.leftDescription", {
                    count,
                    workspace: workspaceLabel(group.workspace),
                  })
                ) : there === null ? (
                  <>
                    {changes(count)} queued on this device by an account that
                    is not signed in{range ? `, from ${range}` : ""}. They were
                    never sent to a server, and they are not replayed under your
                    account — that would file somebody else&apos;s work into
                    your workspace. Sign in as that account on this device to
                    sync them, or discard them here.
                  </>
                ) : (
                  <>
                    {changes(count)} queued on this device while it used{" "}
                    {there}
                    {range ? `, from ${range}` : ""}. They were never sent, and
                    they are not sent to {here} — that would file them on a
                    server they were not made for. Switch this device back to{" "}
                    {there} on the sign-in screen to sync them, or discard them
                    here.
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pb-6">
              <ul className="space-y-1 text-sm" data-testid="foreign-queue-rows">
                {group.rows.map((row) => (
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
                onClick={() => setConfirming(group)}
                data-testid="foreign-queue-discard"
              >
                Discard {changes(count)}
              </Button>
            </CardContent>
          </div>
        );
      })}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent data-testid="foreign-queue-confirm">
          <DialogHeader>
            <DialogTitle>
              Discard {confirming ? confirming.rows.length : 0} unsynced change
              {confirming?.rows.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {confirming?.workspace ? (
                t("foreignQueue.confirmLeft", {
                  workspace: workspaceLabel(confirming.workspace),
                })
              ) : (
              <>
              This deletes work tracked{confirmRange ? ` on ${confirmRange}` : ""}{" "}
              that no server has ever received. It cannot be recovered — not by{" "}
              {confirming?.server
                ? `switching back to ${serverLabel(confirming.server)}`
                : "that account signing in here"}
              , and not from a backup.{" "}
              {confirming?.server
                ? `Switch this device back to ${serverLabel(confirming.server)} instead if it should be kept.`
                : "Sign in as that account on this device instead if it should be kept."}
              </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirming(null)}
              data-testid="foreign-queue-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={discarding}
              onClick={() => {
                if (confirming) void discard(confirming);
              }}
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
