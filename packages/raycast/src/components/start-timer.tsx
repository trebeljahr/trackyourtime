import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useState } from "react";
import { getTrackYourTime } from "../lib/api.js";
import { webLink } from "../lib/preferences.js";
import { refreshMenuBar, replacedNotice, showFailureToast } from "../lib/ui.js";
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
  useProjectBillableDefault,
} from "./entry-fields.js";
import { SignedOutView } from "./signed-out.js";

type FormValues = {
  description: string;
  /** Undefined when the dropdown was not rendered — no projects to pick. */
  projectId?: string;
  taskId?: string;
  /** Undefined when the picker was not rendered — no tags exist yet. */
  tagIds?: string[];
  billable: boolean;
};

export function StartTimer(): React.JSX.Element {
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>(NONE);
  const [billable, setBillable] = useState(false);
  const [taskId, setTaskId] = useState<string>(NONE);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const catalog = useEntryCatalog();
  // Gated on the server's declared API level, never its release: a store
  // build is often newer than a self-hosted server. docs/versioning.md →
  // "Gating a feature on the server".
  const offersDescriptions = useServerLevel().supports("entries.descriptions");

  // A project carries its own billable default; respect it until the user
  // overrides the checkbox themselves.
  useProjectBillableDefault(catalog, projectId, setBillable);

  if (catalog.signedOut) return <SignedOutView />;

  // No `pickProject`: a task does not belong to a project, so changing
  // one leaves the other alone.

  const submit = async (values: FormValues): Promise<void> => {
    setSubmitting(true);
    try {
      const api = await getTrackYourTime();
      const entry = await api.start({
        description: values.description.trim(),
        projectId: orNull(values.projectId),
        taskId: orNull(values.taskId),
        tagIds: values.tagIds ?? [],
        billable: values.billable,
      });
      await refreshMenuBar();
      await showToast({
        style: Toast.Style.Success,
        title: "Timer started",
        message: [entry.description || "No description", replacedNotice(entry)]
          .filter(Boolean)
          .join(" · "),
      });
      await popToRoot();
    } catch (error) {
      await showFailureToast(error, "Could not start the timer");
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
            title="Start Timer"
            icon={Icon.Play}
            onSubmit={submit}
          />
          {/* The completion for the description field. A form cannot offer one
              inline, so it is a pushed list — and the shortcut matters more
              than the row, because reaching for it means the name is already
              half-typed. */}
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
                    // Set last: adopting a project fires the effect above, and
                    // the entry's own flag is the more specific answer.
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
          <Action.OpenInBrowser
            title="Open Web App"
            url={webLink("/app/track")}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="description"
        title="Description"
        placeholder="What are you working on?"
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
      <Form.Description
        text={
          (catalog.projects.data ?? []).length > 0
            ? "Starting a timer stops whatever is already running — Track Your Time keeps one timer at a time."
            : "No projects yet — this timer will be unassigned. Create projects in the web app to file time against them."
        }
      />
    </Form>
  );
}
