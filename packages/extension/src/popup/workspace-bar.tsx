import { useState, type JSX } from "react";
import type { QueuedMutationSummary, WorkspaceSummary } from "@starter/core";
import type { ExtensionTranslator } from "../i18n";
import { ConfirmPanel } from "./confirm-panel";

/**
 * Which workspace the toolbar tracks into, and the changes it is holding for
 * a workspace the person has left.
 *
 * The picker is a native `<select>` on purpose: it needs no popover in a 380px
 * popup, the browser gives it keyboard and screen-reader behaviour for free,
 * and its value can only ever be one of the workspaces the worker listed. It
 * renders nothing for a person in one workspace, which is nearly everybody —
 * the tracker must look exactly as it did for them.
 *
 * Switching here never moves the web app. The worker keeps its own choice and
 * addresses every request with it; see `lib/workspace-choice.ts`.
 */

export type WorkspacePickerProps = {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  disabled?: boolean;
  onSwitch: (workspaceId: string) => void;
  t: ExtensionTranslator<"popup">;
};

export function WorkspacePicker({
  workspaces,
  activeWorkspaceId,
  disabled = false,
  onSwitch,
  t,
}: WorkspacePickerProps): JSX.Element | null {
  if (workspaces.length < 2) return null;
  return (
    <div className="field" data-testid="workspace-picker">
      <label className="field__label" htmlFor="workspace-picker-select">
        {t("workspace.label")}
      </label>
      <select
        id="workspace-picker-select"
        className="select"
        value={activeWorkspaceId ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== "" && next !== activeWorkspaceId) onSwitch(next);
        }}
        data-testid="workspace-picker-select"
      >
        {activeWorkspaceId === null ? <option value="" /> : null}
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export type HeldQueueProps = {
  rows: QueuedMutationSummary[];
  onDiscard: (id: string) => Promise<boolean>;
  t: ExtensionTranslator<"popup">;
};

/** Which group a held row is shown in: a left workspace, or a `HoldReason`. */
type HeldGroup = "left" | NonNullable<QueuedMutationSummary["hold"]>;

const GROUP_ORDER: readonly HeldGroup[] = [
  "left",
  "server-too-old",
  "unknown-procedure",
  "unknown-op",
];

/** Catalog keys per group. A new `HoldReason` is a type error here. */
const GROUP_KEYS = {
  left: { title: "workspace.heldTitle", hint: "workspace.heldHint" },
  "unknown-op": { title: "workspace.waitingNewer.title", hint: "workspace.waitingNewer.hint" },
  "unknown-procedure": {
    title: "workspace.waitingServer.title",
    hint: "workspace.waitingServer.hint",
  },
  "server-too-old": {
    title: "workspace.waitingServerUpdate.title",
    hint: "workspace.waitingServerUpdate.hint",
  },
} as const satisfies Record<HeldGroup, { title: string; hint: string }>;

/**
 * Rows the worker keeps and does not send.
 *
 * Two kinds, each with its own words. Rows queued in a workspace this account
 * no longer belongs to are never sent — not there, which would refuse them,
 * and not anywhere else. Rows `hold` names are waiting for something that may
 * change: a newer extension that can read them, or a server that has the
 * procedure they need. Neither is dropped on its own, because they are time
 * no server has seen. So they are listed by what they were and where, and the
 * one way out is a deliberate, confirmed discard of a named row.
 */
export function HeldQueue({ rows, onDiscard, t }: HeldQueueProps): JSX.Element | null {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (rows.length === 0) return null;

  const workspaceOf = (row: QueuedMutationSummary): string =>
    row.workspaceName ?? t("workspace.leftWorkspace");

  const label = (row: QueuedMutationSummary): string => {
    const what = row.description?.trim() ? row.description : t("workspace.untitled");
    const values = { description: what, workspace: workspaceOf(row) };
    switch (row.op) {
      case "entries.start":
        return t("workspace.ops.start", values);
      case "entries.stop":
        return t("workspace.ops.stop", values);
      case "entries.create":
        return t("workspace.ops.create", values);
      case "entries.update":
        return t("workspace.ops.update", values);
      case "entries.remove":
      case "entries.discard":
        return t("workspace.ops.remove", values);
      default:
        return t("workspace.ops.other", values);
    }
  };

  const groupOf = (row: QueuedMutationSummary): HeldGroup => row.hold ?? "left";

  return (
    <>
      {GROUP_ORDER.map((group) => {
        const members = rows.filter((row) => groupOf(row) === group);
        if (members.length === 0) return null;
        return (
          <div className="panel" data-testid="held-queue" data-hold={group} key={group}>
            <p className="panel__title">{t(GROUP_KEYS[group].title, { count: members.length })}</p>
            <p className="panel__hint">{t(GROUP_KEYS[group].hint)}</p>
            <ul className="held-queue">
              {members.map((row) =>
                confirming === row.queueId ? (
                  <li key={row.queueId}>
                    <ConfirmPanel
                      title={label(row)}
                      hint={
                        group === "left"
                          ? t("workspace.discardHint", { workspace: workspaceOf(row) })
                          : t("workspace.discardHintWaiting")
                      }
                      confirmLabel={t("workspace.discard")}
                      danger
                      busy={busy}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => {
                        setBusy(true);
                        void onDiscard(row.queueId).finally(() => {
                          setBusy(false);
                          setConfirming(null);
                        });
                      }}
                      testId="held-queue-confirm"
                    />
                  </li>
                ) : (
                  <li key={row.queueId} className="held-queue__row" data-testid="held-queue-row">
                    <span>{label(row)}</span>
                    <button
                      type="button"
                      className="button--link"
                      onClick={() => setConfirming(row.queueId)}
                      data-testid="held-queue-discard"
                    >
                      {t("workspace.discard")}
                    </button>
                  </li>
                ),
              )}
            </ul>
          </div>
        );
      })}
    </>
  );
}
