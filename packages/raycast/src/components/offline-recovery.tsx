import {
  Action,
  ActionPanel,
  Alert,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { repairRecoveryInput, type RecoveryFieldEdits, type RecoveryTarget } from "../vendor/index.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  discardQueuedRecovery,
  exportQueuedRecovery,
  listForeign,
  retryQueuedRecovery,
  targetsForQueuedRecovery,
  type ForeignQueuedRow,
} from "../lib/offline.js";
import { showFailureToast } from "../lib/ui.js";

function RepairChange({ row, onChanged }: { row: ForeignQueuedRow; onChanged: () => void }): React.JSX.Element {
  const { pop } = useNavigation();
  const original = row.recovery?.input as Record<string, unknown> | null;
  const [input, setInput] = useState(() => JSON.stringify(original, null, 2) ?? "{}");
  const [edits, setEdits] = useState<RecoveryFieldEdits>({});
  const [advanced, setAdvanced] = useState(false);
  const [targets, setTargets] = useState<RecoveryTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    if (!row.recovery?.needsStopTarget) return;
    void targetsForQueuedRecovery(row.queueId)
      .then(setTargets)
      .catch(() => setValidation("Could not load entries. Try again when online."));
  }, [row.queueId, row.recovery?.needsStopTarget]);
  const dateValue = (field: "start" | "end"): Date | null => {
    const value = edits[field] ?? original?.[field];
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
    return new Date(value);
  };
  return (
    <Form
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Repair and Retry Chain"
            onSubmit={async () => {
              setBusy(true);
              setValidation(null);
              try {
                let replacement: unknown;
                if (advanced) {
                  try {
                    replacement = JSON.parse(input);
                  } catch {
                    throw new Error("RECOVERY_INVALID_JSON");
                  }
                } else {
                  if (row.recovery?.needsStopTarget && !edits.id) throw new Error("RECOVERY_STOP_TARGET_REQUIRED");
                  replacement = repairRecoveryInput(row.op ?? "", original, edits);
                }
                await retryQueuedRecovery(row.queueId, replacement);
                onChanged();
                pop();
                await showToast({ style: Toast.Style.Success, title: "Chain ready to sync" });
              } catch (error) {
                const code = error instanceof Error ? error.message : "";
                const message =
                  code === "RECOVERY_INVALID_JSON" || code === "RECOVERY_INVALID_INPUT"
                    ? "Enter a valid JSON object, or turn off Advanced JSON and use the repair fields."
                    : code === "RECOVERY_INVALID_DATE"
                      ? "Choose a valid date and time."
                      : code === "RECOVERY_END_BEFORE_START"
                        ? "End must be after start. Correct the dates and times."
                        : code === "RECOVERY_STOP_TARGET_REQUIRED"
                          ? "Choose the original entry for this stop. Today's timer is never selected for you."
                          : "Could not recover this change. Check sign-in, workspace access and the refusal reason. Your work is still saved.";
                setValidation(message);
                await showToast({ style: Toast.Style.Failure, title: "Check the repair fields", message });
              } finally {
                setBusy(false);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Reason"
        text={`${row.recovery?.code ?? ""} ${row.recovery?.message ?? row.hold ?? ""}`}
      />
      <Form.Description text="Correct the description, dates or unavailable selections before retrying. The whole start/stop chain stays together. Original content stays saved until sync or discard." />
      {["entries.start", "entries.create", "entries.update"].includes(row.op ?? "") ? (
        <>
          <Form.TextField
            id="description"
            title="Description"
            value={edits.description ?? (typeof original?.description === "string" ? original.description : "")}
            onChange={(description) => setEdits({ ...edits, description })}
          />
          <Form.DatePicker
            id="start"
            title="Start"
            type={Form.DatePicker.Type.DateTime}
            value={dateValue("start")}
            onChange={(date) => setEdits({ ...edits, start: date?.toISOString() ?? "" })}
          />
          {row.op !== "entries.start" ? (
            <Form.DatePicker
              id="end"
              title="End"
              type={Form.DatePicker.Type.DateTime}
              value={dateValue("end")}
              onChange={(date) => setEdits({ ...edits, end: date?.toISOString() ?? "" })}
            />
          ) : null}
          <Form.Checkbox
            id="clearCatalog"
            label="Clear unavailable client, project, task and tags"
            value={edits.clearCatalog ?? false}
            onChange={(clearCatalog) => setEdits({ ...edits, clearCatalog })}
          />
        </>
      ) : null}
      {row.op === "entries.stop" ? (
        <Form.DatePicker
          id="end"
          title="End"
          type={Form.DatePicker.Type.DateTime}
          value={dateValue("end")}
          onChange={(date) => setEdits({ ...edits, end: date?.toISOString() ?? "" })}
        />
      ) : null}
      {row.recovery?.needsStopTarget ? (
        <Form.Dropdown
          id="target"
          title="Original Entry to Close"
          value={edits.id ?? ""}
          onChange={(id) => setEdits({ ...edits, id })}
        >
          <Form.Dropdown.Item value="" title="Choose the original entry" />
          {targets.map((target) => (
            <Form.Dropdown.Item
              key={target.id}
              value={target.id}
              title={`${target.description || "Untitled entry"} · ${target.start}`}
            />
          ))}
        </Form.Dropdown>
      ) : null}
      {validation ? <Form.Description title="Check the fields" text={validation} /> : null}
      <Form.Checkbox
        id="advanced"
        label="Use Advanced JSON instead of the repair fields"
        value={advanced}
        onChange={setAdvanced}
      />
      {advanced ? <Form.TextArea id="input" title="Input Fields (JSON)" value={input} onChange={setInput} /> : null}
      <Form.Description title="Original Change" text={JSON.stringify(row.recovery?.originalPayload, null, 2)} />
    </Form>
  );
}

function ExportChange({ row }: { row: ForeignQueuedRow }): React.JSX.Element {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save a Copy"
            onSubmit={async (values: { folder: string[] }) => {
              try {
                if (!values.folder[0]) throw new Error("Choose a folder first");
                const json = await exportQueuedRecovery(row.queueId);
                const filename = join(values.folder[0], `trackyourtime-unsynced-${Date.now()}.json`);
                await writeFile(filename, json, { flag: "wx", mode: 0o600 });
                await showToast({ style: Toast.Style.Success, title: "Copy saved", message: filename });
                pop();
              } catch (error) {
                await showFailureToast(error, "Could not recover this change");
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="Save the original change and its start/stop chain to a JSON file. The saved queue stays on this Mac." />
      <Form.FilePicker
        id="folder"
        title="Save in Folder"
        canChooseFiles={false}
        canChooseDirectories
        allowMultipleSelection={false}
      />
    </Form>
  );
}

export function OfflineRecovery({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<ForeignQueuedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = (): void => {
    setLoading(true);
    void listForeign("held")
      .then(setRows)
      .catch((error: unknown) => showFailureToast(error, "Could not load saved changes"))
      .finally(() => setLoading(false));
    onChanged();
  };
  useEffect(() => {
    void listForeign("held")
      .then(setRows)
      .catch((error: unknown) => showFailureToast(error, "Could not load saved changes"))
      .finally(() => setLoading(false));
  }, []);
  return (
    <List isLoading={loading} navigationTitle="Not Synced">
      {rows.map((row) => (
        <List.Item
          key={row.queueId}
          title={row.description || row.op || "Queued change"}
          subtitle={row.recovery?.message || row.hold || ""}
          accessories={[{ text: row.workspaceName ?? "" }]}
          actions={
            <ActionPanel>
              {row.recovery && row.op !== null && row.hold !== "unknown-op" ? (
                <Action.Push
                  title="Review and Repair…"
                  icon={Icon.Pencil}
                  target={<RepairChange row={row} onChanged={reload} />}
                />
              ) : null}
              {row.recovery ? (
                <Action.Push title="Save a Copy…" icon={Icon.Download} target={<ExportChange row={row} />} />
              ) : null}
              {row.recovery ? (
                <Action
                  title="Discard Chain…"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    if (
                      !(await confirmAlert({
                        title: "Discard this unsynced chain?",
                        message: "The original work and its start/stop chain will be deleted from this Mac.",
                        primaryAction: { title: "Discard", style: Alert.ActionStyle.Destructive },
                      }))
                    )
                      return;
                    try {
                      await discardQueuedRecovery(row.queueId);
                      reload();
                    } catch (error) {
                      await showFailureToast(error, "Could not recover this change");
                    }
                  }}
                />
              ) : null}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
