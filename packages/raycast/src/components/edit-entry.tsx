import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import type { DetailedEntry } from "@starter/core";
import { useState } from "react";
import { getTrackYourTime } from "../lib/api.js";
import { refreshMenuBar, showFailureToast } from "../lib/ui.js";
import { useServerLevel } from "../lib/server-level.js";
import { DescriptionPicker } from "./description-picker.js";
import {
  NONE,
  catalogActions,
  orNone,
  orNull,
  projectField,
  tagsField,
  taskField,
  useEntryCatalog,
} from "./entry-fields.js";
import { SignedOutView } from "./signed-out.js";

type Props = {
  entry: DetailedEntry;
  /** Called after a successful save, so the list can revalidate. */
  onSaved: () => void;
};

type FormValues = {
  description: string;
  /** Undefined when the dropdown was not rendered — nothing to pick. */
  projectId?: string;
  taskId?: string;
  /** Undefined when the picker was not rendered — no tags exist yet. */
  tagIds?: string[];
  billable: boolean;
  start: Date | null;
  end: Date | null;
};

/**
 * Edit one entry. A running entry keeps running: its end stays empty, and
 * clearing the end of a finished entry deliberately puts it back to running,
 * which is the same contract the web app's editor has.
 */
export function EditEntry({ entry, onSaved }: Props): React.JSX.Element {
  const { pop } = useNavigation();
  const [description, setDescription] = useState(entry.description);
  const [projectId, setProjectId] = useState(orNone(entry.projectId));
  const [taskId, setTaskId] = useState(orNone(entry.taskId));
  const [billable, setBillable] = useState(entry.billable);
  const [tagIds, setTagIds] = useState<string[]>(entry.tagIds);
  const [submitting, setSubmitting] = useState(false);

  const catalog = useEntryCatalog();
  // Gated on the server's declared API level, never its release: a store
  // build is often newer than a self-hosted server. docs/versioning.md →
  // "Gating a feature on the server".
  const offersDescriptions = useServerLevel().supports("entries.descriptions");

  if (catalog.signedOut) return <SignedOutView />;

  // No `pickProject`: a task does not belong to a project, so changing
  // one leaves the other alone.

  const submit = async (values: FormValues): Promise<void> => {
    if (values.start && values.end && values.end <= values.start) {
      await showToast({
        style: Toast.Style.Failure,
        title: "End must be after start",
      });
      return;
    }

    setSubmitting(true);
    try {
      const api = await getTrackYourTime();
      await api.update({
        id: entry.id,
        description: values.description.trim(),
        projectId: orNull(values.projectId),
        taskId: orNull(values.taskId),
        // Always sent, so clearing every tag in the picker actually clears
        // them rather than reading as "leave the tags alone".
        tagIds: values.tagIds ?? [],
        billable: values.billable,
        start: (values.start ?? new Date(entry.start)).toISOString(),
        end: values.end ? values.end.toISOString() : null,
      });
      await refreshMenuBar();
      await showToast({ style: Toast.Style.Success, title: "Entry saved" });
      onSaved();
      pop();
    } catch (error) {
      await showFailureToast(error, "Could not save the entry");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form
      isLoading={catalog.isLoading || submitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Entry"
            icon={Icon.Check}
            onSubmit={submit}
          />
          {offersDescriptions ? (
            <Action.Push
              title="Pick a Past Description…"
              icon={Icon.MagnifyingGlass}
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
              target={
                <DescriptionPicker
                  projectId={projectId === NONE ? null : projectId}
                  onPick={setDescription}
                  onAdopt={(suggestion) => {
                    setDescription(suggestion.description);
                    setProjectId(orNone(suggestion.projectId));
                    setTaskId(orNone(suggestion.taskId));
                    setTagIds([...suggestion.tagIds]);
                    setBillable(suggestion.billable);
                  }}
                />
              }
            />
          ) : null}
          {catalogActions(catalog, {
            onProject: setProjectId,
            onTask: setTaskId,
            onTag: (id) => setTagIds((current) => [...current, id]),
          })}
        </ActionPanel>
      }
    >
      <Form.TextField
        id="description"
        title="Description"
        placeholder="What did you work on?"
        value={description}
        onChange={setDescription}
        info="⌘⇧D searches what you have tracked before."
      />
      {projectField(catalog, projectId, setProjectId)}
      {taskField(catalog, taskId, setTaskId)}
      {tagsField(catalog, tagIds, setTagIds)}
      <Form.Checkbox
        id="billable"
        label="Billable"
        value={billable}
        onChange={setBillable}
      />
      <Form.DatePicker
        id="start"
        title="Start"
        type={Form.DatePicker.Type.DateTime}
        defaultValue={new Date(entry.start)}
      />
      <Form.DatePicker
        id="end"
        title="End"
        type={Form.DatePicker.Type.DateTime}
        defaultValue={entry.end ? new Date(entry.end) : null}
        info="Leave empty to keep the timer running."
      />
    </Form>
  );
}
