"use client";

import * as React from "react";
import { Building2, Hourglass, ServerOff, UserRoundX } from "lucide-react";
import { serverLabel, type HoldReason } from "@starter/core";

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
import { translate } from "@/i18n/translate";
import { useFormat, type LocaleFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";
import {
  discardForeignQueued,
  listForeignQueued,
  type ForeignQueuedRow,
  type OfflineOp,
} from "@/lib/offline";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";

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
 *
 * And for this account's HELD rows — written by a newer app version, or
 * needing a procedure the server does not have (`HoldReason` in core). They
 * are grouped per reason, because the way to keep them is different again:
 * update the app, or ask the admin to update the server.
 */

/** Catalog keys per hold reason. A new reason is a type error here. */
const HELD_KEYS = {
  "unknown-op": {
    title: "foreignQueue.held.unknownOp.title",
    description: "foreignQueue.held.unknownOp.description",
  },
  "unknown-procedure": {
    title: "foreignQueue.held.unknownProcedure.title",
    description: "foreignQueue.held.unknownProcedure.description",
  },
  "server-too-old": {
    title: "foreignQueue.held.serverTooOld.title",
    description: "foreignQueue.held.serverTooOld.description",
  },
} as const satisfies Record<HoldReason, { title: string; description: string }>;

/**
 * Catalog key per op. The ops themselves are dotted tRPC paths, which cannot
 * be message keys; `describeQueuedMutation` in core stays structured, so the
 * words are chosen here and Raycast keeps its own.
 */
const OP_KEYS = {
  "entries.start": "foreignQueue.ops.start",
  "entries.stop": "foreignQueue.ops.stop",
  "entries.create": "foreignQueue.ops.create",
  "entries.update": "foreignQueue.ops.update",
  "entries.remove": "foreignQueue.ops.remove",
  "entries.discard": "foreignQueue.ops.discard",
} as const satisfies Record<OfflineOp, string>;

/** "21 Aug" or "21 Aug – 22 Aug" — enough to recognise, short enough for a sentence. */
const formatRange = (rows: ForeignQueuedRow[], f: LocaleFormat): string | null => {
  const times = rows
    .map((row) => new Date(row.at).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b);
  if (times.length === 0) return null;

  const first = f.date(times[0], "dayMonth");
  const last = f.date(times[times.length - 1], "dayMonth");
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
  /** Set for this account's held rows: why they cannot be sent yet. */
  hold: HoldReason | null;
  rows: ForeignQueuedRow[];
};

const groupKey = (row: ForeignQueuedRow): string => {
  if (row.otherServer !== null) return `server:${row.otherServer}`;
  if (row.hold !== null) return `held:${row.hold}`;
  if (row.leftWorkspace) return `workspace:${row.workspaceId ?? ""}`;
  return "account";
};

/**
 * Another account on this server first, then left workspaces, then servers,
 * then this account's held rows — the only group that can clear by itself.
 */
const groupRank = (group: Group): number =>
  group.hold !== null ? 3 : group.server !== null ? 2 : group.workspace !== null ? 1 : 0;

const groupRows = (rows: ForeignQueuedRow[]): Group[] => {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? {
      server: row.otherServer,
      workspace:
        row.otherServer === null && row.hold === null && row.leftWorkspace
          ? { id: row.workspaceId ?? "", name: row.workspaceName }
          : null,
      hold: row.otherServer === null ? row.hold : null,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  // Another account on this server first: it is the one the tracker bar's
  // badge most often means.
  return [...groups.values()].sort((a, b) => groupRank(a) - groupRank(b));
};

export function ForeignQueuePanel(): React.JSX.Element | null {
  const { foreign: others, held } = useOfflineQueueState();
  const foreign = others + held;
  const t = useT("settings");
  const tc = useT("common");
  const f = useFormat();
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

  const label = (row: ForeignQueuedRow): string =>
    row.op === null ? t("foreignQueue.ops.unknown") : t(OP_KEYS[row.op]);

  const formatAt = (iso: string): string =>
    f.date(iso, { dateStyle: "medium", timeStyle: "short" }) ||
    t("foreignQueue.unknownTime");

  const discard = async (group: Group): Promise<void> => {
    setDiscarding(true);
    try {
      const removed = await discardForeignQueued(
        group.rows.map((row) => row.queueId),
      );
      setConfirming(null);
      toast.success(
        translate("settings")("foreignQueue.toasts.discarded", { count: removed }),
      );
    } catch {
      toast.error(translate("settings")("foreignQueue.toasts.discardFailed"));
    } finally {
      setDiscarding(false);
    }
  };

  const confirmRange = confirming ? formatRange(confirming.rows, f) : null;
  const confirmServer =
    confirming?.server ? serverLabel(confirming.server) : null;
  const workspaceLabel = (workspace: { name: string | null }): string =>
    workspace.name ?? t("foreignQueue.leftWorkspace");

  return (
    <Card data-testid="foreign-queue-panel">
      {groups.length === 0 ? (
        // The count arrived before the rows did.
        <CardHeader>
          <CardTitle>{t("foreignQueue.titleDevice")}</CardTitle>
          <CardDescription>
            {t("foreignQueue.pendingRows", { count: foreign })}
          </CardDescription>
        </CardHeader>
      ) : null}

      {groups.map((group) => {
        const range = formatRange(group.rows, f);
        const count = group.rows.length;
        const there = group.server === null ? null : serverLabel(group.server);
        return (
          <div
            key={groupKey(group.rows[0])}
            className="border-b last:border-b-0"
            data-testid="foreign-queue-group"
            data-server={group.server ?? ""}
            data-workspace-id={group.workspace?.id ?? ""}
            data-hold={group.hold ?? ""}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {group.hold !== null ? (
                  <>
                    <Hourglass className="size-4" />
                    {t(HELD_KEYS[group.hold].title)}
                  </>
                ) : group.workspace !== null ? (
                  <>
                    <Building2 className="size-4" />
                    {t("foreignQueue.leftTitle", {
                      workspace: workspaceLabel(group.workspace),
                    })}
                  </>
                ) : there === null ? (
                  <>
                    <UserRoundX className="size-4" />
                    {t("foreignQueue.title")}
                  </>
                ) : (
                  <>
                    <ServerOff className="size-4" />
                    {t("foreignQueue.titleServer", { server: there })}
                  </>
                )}
              </CardTitle>
              <CardDescription>
                {group.hold !== null ? (
                  t(HELD_KEYS[group.hold].description, { count })
                ) : group.workspace !== null ? (
                  t("foreignQueue.leftDescription", {
                    count,
                    workspace: workspaceLabel(group.workspace),
                  })
                ) : there === null ? (
                  <>
                    {range
                      ? t("foreignQueue.summaryWithRange", { count, range })
                      : t("foreignQueue.summary", { count })}{" "}
                    {t("foreignQueue.explanation")}
                  </>
                ) : (
                  <>
                    {range
                      ? t("foreignQueue.serverSummaryWithRange", {
                          count,
                          server: there,
                          range,
                        })
                      : t("foreignQueue.serverSummary", { count, server: there })}{" "}
                    {t("foreignQueue.serverExplanation", { server: there, here })}
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
                {t("foreignQueue.discard", { count })}
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
              {t("foreignQueue.confirm.title", {
                count: confirming ? confirming.rows.length : 0,
              })}
            </DialogTitle>
            <DialogDescription>
              {confirming?.hold
                ? t("foreignQueue.held.confirm")
                : confirming?.workspace
                ? t("foreignQueue.confirmLeft", {
                    workspace: workspaceLabel(confirming.workspace),
                  })
                : confirmServer
                  ? confirmRange
                    ? t("foreignQueue.confirm.serverDescriptionWithRange", {
                        range: confirmRange,
                        server: confirmServer,
                      })
                    : t("foreignQueue.confirm.serverDescription", { server: confirmServer })
                  : confirmRange
                    ? t("foreignQueue.confirm.descriptionWithRange", { range: confirmRange })
                    : t("foreignQueue.confirm.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirming(null)}
              data-testid="foreign-queue-cancel"
            >
              {tc("actions.cancel")}
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
              {t("foreignQueue.confirm.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
