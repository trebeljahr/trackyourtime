"use client";

import * as React from "react";
import {
  heldRowOffersRepair,
  holdSendsAutomatically,
  repairRecoveryInput,
  recoveryLocalTime,
  type RecoveryFieldEdits,
  type RecoveryTarget,
} from "@starter/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n/use-t";
import { useFormat } from "@/i18n/use-format";
import { downloadBlob } from "@/lib/download";
import { trpc } from "@/lib/trpc";
import {
  exportQueuedRecovery,
  retryQueuedRecovery,
  queuedRecoveryTargetInput,
  filterQueuedRecoveryTargets,
  type ForeignQueuedRow,
} from "@/lib/offline";
import { useOfflineQueueState } from "@/providers/offline-queue-provider";

function OwnQueueRecovery({
  row,
}: {
  row: ForeignQueuedRow;
}): React.JSX.Element | null {
  const t = useT("settings");
  const f = useFormat();
  const utils = trpc.useUtils();
  const { flush } = useOfflineQueueState();
  const [editing, setEditing] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [input, setInput] = React.useState(
    () => JSON.stringify(row.recovery?.input, null, 2) ?? "{}",
  );
  const [edits, setEdits] = React.useState<RecoveryFieldEdits>({});
  const [targets, setTargets] = React.useState<RecoveryTarget[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [validation, setValidation] = React.useState<string | null>(null);
  if (!row.recovery) return null;
  const original = row.recovery.input as Record<string, unknown> | null;
  const perform = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setValidation(null);
    try {
      await task();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setValidation(
        code === "RECOVERY_INVALID_JSON" || code === "RECOVERY_INVALID_INPUT"
          ? t("foreignQueue.recovery.invalidJson")
          : code === "RECOVERY_INVALID_DATE"
            ? t("foreignQueue.recovery.invalidDate")
            : code === "RECOVERY_END_BEFORE_START"
              ? t("foreignQueue.recovery.endBeforeStart")
              : code === "RECOVERY_STOP_TARGET_REQUIRED"
                ? t("foreignQueue.recovery.targetRequired")
                : t("foreignQueue.recovery.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const repair = (): unknown => {
    if (row.recovery?.needsStopTarget && !editing)
      throw new Error("RECOVERY_STOP_TARGET_REQUIRED");
    if (!editing) return undefined;
    if (advanced) {
      try {
        return JSON.parse(input);
      } catch {
        throw new Error("RECOVERY_INVALID_JSON");
      }
    }
    if (row.recovery?.needsStopTarget && !edits.id)
      throw new Error("RECOVERY_STOP_TARGET_REQUIRED");
    return repairRecoveryInput(row.op ?? "", row.recovery?.input, edits);
  };
  const field = (name: "start" | "end"): React.JSX.Element => (
    <label className="block text-sm">
      {t(
        name === "start"
          ? "foreignQueue.recovery.start"
          : "foreignQueue.recovery.end",
      )}
      <Input
        type="datetime-local"
        step="1"
        value={edits[name] ?? recoveryLocalTime(original?.[name])}
        onChange={(event) => setEdits({ ...edits, [name]: event.target.value })}
        data-testid={`queue-recovery-${name}`}
      />
    </label>
  );
  const automatic = holdSendsAutomatically(row.hold);
  const downloadButton = (
    <Button
      variant="outline"
      disabled={busy}
      data-testid="queue-recovery-export"
      onClick={() =>
        void perform(async () => {
          const json = await exportQueuedRecovery([row.queueId]);
          const file = new File([json], "trackyourtime-unsynced.json", {
            type: "application/json",
          });
          if (navigator.canShare?.({ files: [file] }))
            await navigator.share({ files: [file] });
          else downloadBlob(file.name, file);
        })
      }
    >
      {t("foreignQueue.recovery.download")}
    </Button>
  );
  const originalChange = (
    <details>
      <summary>{t("foreignQueue.recovery.original")}</summary>
      <pre className="overflow-auto whitespace-pre-wrap text-xs">
        {JSON.stringify(row.recovery.originalPayload, null, 2)}
      </pre>
      {automatic ? downloadButton : null}
    </details>
  );
  // Waiting on the server alone: nothing to repair, and a retry cannot send
  // it before the server's level rises. The group's Discard stays.
  if (automatic)
    return (
      <div
        className="w-full space-y-1"
        data-testid="queue-recovery"
        data-mode="automatic"
      >
        <p
          className="text-xs text-muted-foreground"
          data-testid="queue-recovery-automatic"
        >
          {t("foreignQueue.recovery.automatic")}
        </p>
        {originalChange}
        {validation ? (
          <p role="alert" className="text-sm text-destructive">
            {validation}
          </p>
        ) : null}
      </div>
    );
  return (
    <div
      className="w-full space-y-2"
      data-testid="queue-recovery"
      data-mode="manual"
    >
      <p className="text-sm">
        {row.recovery.code} {row.recovery.message}
      </p>
      {originalChange}
      <p className="text-xs text-muted-foreground">
        {t("foreignQueue.recovery.hint")}
      </p>
      {editing ? (
        <div className="space-y-2">
          {["entries.start", "entries.create", "entries.update"].includes(
            row.op ?? "",
          ) ? (
            <>
              <label className="block text-sm">
                {t("foreignQueue.recovery.description")}
                <Input
                  value={
                    edits.description ??
                    (typeof original?.description === "string"
                      ? original.description
                      : "")
                  }
                  onChange={(event) =>
                    setEdits({ ...edits, description: event.target.value })
                  }
                  data-testid="queue-recovery-description"
                />
              </label>
              {field("start")}
              {row.op !== "entries.start" ? field("end") : null}
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={edits.clearCatalog ?? false}
                  onChange={(event) =>
                    setEdits({ ...edits, clearCatalog: event.target.checked })
                  }
                  data-testid="queue-recovery-clear-catalog"
                />
                {t("foreignQueue.recovery.clearCatalog")}
              </label>
            </>
          ) : null}
          {row.op === "entries.stop" ? field("end") : null}
          {row.recovery.needsStopTarget ? (
            <div className="space-y-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const lookup = await queuedRecoveryTargetInput(row.queueId);
                    if (!lookup) throw new Error("RECOVERY_SCOPE_CHANGED");
                    const page = await utils.entries.list.fetch(lookup.input);
                    setTargets(
                      filterQueuedRecoveryTargets(page.entries, lookup.row),
                    );
                  })
                }
              >
                {t("foreignQueue.recovery.loadTargets")}
              </Button>
              <label className="block text-sm">
                {t("foreignQueue.recovery.target")}
                <select
                  className="w-full rounded border p-2"
                  value={edits.id ?? ""}
                  onChange={(event) =>
                    setEdits({ ...edits, id: event.target.value })
                  }
                  data-testid="queue-recovery-target"
                >
                  <option value="">
                    {t("foreignQueue.recovery.chooseTarget")}
                  </option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.description ||
                        t("foreignQueue.recovery.untitled")}{" "}
                      ·{" "}
                      {f.date(target.start, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          <details>
            <summary>{t("foreignQueue.recovery.advanced")}</summary>
            <label className="block text-sm">
              <input
                type="checkbox"
                checked={advanced}
                onChange={(event) => setAdvanced(event.target.checked)}
              />
              {t("foreignQueue.recovery.useJson")}
            </label>
            <label className="block text-sm">
              {t("foreignQueue.recovery.input")}
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={10}
                data-testid="queue-recovery-input"
              />
            </label>
          </details>
        </div>
      ) : null}
      {validation ? (
        <p role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {heldRowOffersRepair(row) ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(!editing)}
            >
              {t("foreignQueue.recovery.edit")}
            </Button>
            <Button
              disabled={busy}
              data-testid="queue-recovery-retry"
              onClick={() =>
                void perform(async () => {
                  await retryQueuedRecovery(row.queueId, repair());
                  await flush();
                })
              }
            >
              {t("foreignQueue.recovery.retry")}
            </Button>
          </>
        ) : null}
        {downloadButton}
      </div>
    </div>
  );
}

export function QueueRecovery({
  row,
}: {
  row: ForeignQueuedRow;
}): React.JSX.Element | null {
  return row.recovery ? <OwnQueueRecovery row={row} /> : null;
}
