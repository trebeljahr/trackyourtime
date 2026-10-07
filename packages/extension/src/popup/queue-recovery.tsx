import { useState, type JSX } from "react";
import {
  heldRowOffersRepair,
  holdSendsAutomatically,
  repairRecoveryInput,
  recoveryLocalTime,
  type RecoveryFieldEdits,
  type RecoveryTarget,
} from "@starter/core";
import type { HeldSyncRow } from "../lib/messaging";
import type { ExtensionTranslator } from "../i18n";

export function QueueRecovery({
  row,
  onRetry,
  onExport,
  onTargets,
  t,
}: {
  row: HeldSyncRow;
  onRetry?: (id: string, input?: unknown) => Promise<boolean>;
  onExport?: (id: string) => Promise<string | null>;
  onTargets?: (id: string) => Promise<RecoveryTarget[]>;
  t: ExtensionTranslator<"popup">;
}): JSX.Element | null {
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [input, setInput] = useState(
    () => JSON.stringify(row.recovery?.input, null, 2) ?? "{}",
  );
  const [edits, setEdits] = useState<RecoveryFieldEdits>({});
  const [targets, setTargets] = useState<RecoveryTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
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
          ? t("workspace.recovery.invalidJson")
          : code === "RECOVERY_INVALID_DATE"
            ? t("workspace.recovery.invalidDate")
            : code === "RECOVERY_END_BEFORE_START"
              ? t("workspace.recovery.endBeforeStart")
              : code === "RECOVERY_STOP_TARGET_REQUIRED"
                ? t("workspace.recovery.targetRequired")
                : t("workspace.recovery.failed"),
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
  const field = (name: "start" | "end"): JSX.Element => (
    <label className="field">
      {t(
        name === "start"
          ? "workspace.recovery.start"
          : "workspace.recovery.end",
      )}
      <input
        className="input"
        type="datetime-local"
        step="1"
        value={edits[name] ?? recoveryLocalTime(original?.[name])}
        onChange={(event) => setEdits({ ...edits, [name]: event.target.value })}
      />
    </label>
  );
  const downloadButton = onExport ? (
    <button
      type="button"
      disabled={busy}
      onClick={() =>
        void perform(async () => {
          const json = await onExport(row.queueId);
          if (json === null) throw new Error("export failed");
          const url = URL.createObjectURL(
            new Blob([json], { type: "application/json" }),
          );
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "trackyourtime-unsynced.json";
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        })
      }
    >
      {t("workspace.recovery.download")}
    </button>
  ) : null;
  const originalChange = (
    <details>
      <summary>{t("workspace.recovery.original")}</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(row.recovery.originalPayload, null, 2)}
      </pre>
      {holdSendsAutomatically(row.hold) ? downloadButton : null}
    </details>
  );
  // Waiting on the server alone: nothing to repair, and a retry cannot send
  // it before the server's level rises. The row's Discard stays.
  if (holdSendsAutomatically(row.hold))
    return (
      <div className="queue-recovery" data-testid="queue-recovery" data-mode="automatic">
        <p className="panel__hint" data-testid="queue-recovery-automatic">
          {t("workspace.recovery.automatic")}
        </p>
        {originalChange}
        {validation ? <p role="alert">{validation}</p> : null}
      </div>
    );
  return (
    <div className="queue-recovery" data-testid="queue-recovery" data-mode="manual">
      <p>
        {row.recovery.code} {row.recovery.message}
      </p>
      {originalChange}
      <p className="panel__hint">{t("workspace.recovery.hint")}</p>
      {editing ? (
        <div>
          {["entries.start", "entries.create", "entries.update"].includes(
            row.op ?? "",
          ) ? (
            <>
              <label className="field">
                {t("workspace.recovery.description")}
                <input
                  className="input"
                  value={
                    edits.description ??
                    (typeof original?.description === "string"
                      ? original.description
                      : "")
                  }
                  onChange={(event) =>
                    setEdits({ ...edits, description: event.target.value })
                  }
                />
              </label>
              {field("start")}
              {row.op !== "entries.start" ? field("end") : null}
              <label>
                <input
                  type="checkbox"
                  checked={edits.clearCatalog ?? false}
                  onChange={(event) =>
                    setEdits({ ...edits, clearCatalog: event.target.checked })
                  }
                />
                {t("workspace.recovery.clearCatalog")}
              </label>
            </>
          ) : null}
          {row.op === "entries.stop" ? field("end") : null}
          {row.recovery.needsStopTarget ? (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () =>
                    setTargets((await onTargets?.(row.queueId)) ?? []),
                  )
                }
              >
                {t("workspace.recovery.loadTargets")}
              </button>
              <label>
                {t("workspace.recovery.target")}
                <select
                  className="select"
                  value={edits.id ?? ""}
                  onChange={(event) =>
                    setEdits({ ...edits, id: event.target.value })
                  }
                >
                  <option value="">
                    {t("workspace.recovery.chooseTarget")}
                  </option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.description || t("workspace.recovery.untitled")} ·{" "}
                      {recoveryLocalTime(target.start).replace("T", " ")}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          <details>
            <summary>{t("workspace.recovery.advanced")}</summary>
            <label>
              <input
                type="checkbox"
                checked={advanced}
                onChange={(event) => setAdvanced(event.target.checked)}
              />
              {t("workspace.recovery.useJson")}
            </label>
            <label>
              {t("workspace.recovery.input")}
              <textarea
                className="input"
                rows={10}
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
          </details>
        </div>
      ) : null}
      {heldRowOffersRepair(row) && onRetry ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(!editing)}
          >
            {t("workspace.recovery.edit")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                if (!(await onRetry(row.queueId, repair())))
                  throw new Error("recovery failed");
              })
            }
          >
            {t("workspace.recovery.retry")}
          </button>
        </>
      ) : null}
      {downloadButton}
      {validation ? <p role="alert">{validation}</p> : null}
    </div>
  );
}
