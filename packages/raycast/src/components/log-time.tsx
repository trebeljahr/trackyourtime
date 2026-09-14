/**
 * Log a block of work that was never timed.
 *
 * The web app has had this since the tracker bar grew its `+`; Raycast could
 * only ever start a timer, which meant the one thing you reach for a launcher
 * to do — record the meeting you forgot to time, without leaving what you are
 * doing — was the one thing it could not. `entries.create` is the same
 * endpoint the web dialog and the extension popup write through, so an entry
 * logged here is indistinguishable from one logged there.
 *
 * The web dialog offers date, start, end and duration as four controls that
 * drive one range. Raycast has no duration field and no way to lay four
 * controls on one line, so this asks for the two instants instead — the same
 * shape the edit form already uses, which is also the shape that cannot
 * disagree with itself.
 */
import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { defaultManualRange } from "@starter/core";
import { useState } from "react";
import { getTrackYourTime } from "../lib/api.js";
import { formatDurationShort } from "../lib/format.js";
import { refreshMenuBar, showFailureToast } from "../lib/ui.js";
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

type Props = {
  /** Called after a successful write, so the list behind this can revalidate. */
  onSaved: () => void;
};

type FormValues = {
  description: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable: boolean;
  start: Date | null;
  end: Date | null;
};

export function LogTime({ onSaved }: Props): React.JSX.Element {
  const { pop } = useNavigation();
  // Frozen at mount: the defaults are what the pickers opened on, and
  // recomputing them mid-edit would move a range the user is already reading.
  const [range] = useState(defaultManualRange);

  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>(NONE);
  const [taskId, setTaskId] = useState<string>(NONE);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [billable, setBillable] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const catalog = useEntryCatalog();

  // Same rule as starting a timer: a project's billable default applies until
  // the user says otherwise.
  useProjectBillableDefault(catalog, projectId, setBillable);

  if (catalog.signedOut) return <SignedOutView />;

  // No `pickProject`: a task does not belong to a project, so changing
  // one leaves the other alone.

  const submit = async (values: FormValues): Promise<void> => {
    if (!values.start || !values.end) {
      await showToast({
        style: Toast.Style.Failure,
        title: "A logged entry needs both a start and an end",
      });
      return;
    }

    // No midnight roll here, unlike the web dialog. That one's end field holds
    // a time of day with the date taken from elsewhere, so 23:30 to 00:30 is an
    // hour of work it would be wrong to clamp. These two pickers each carry
    // their own date, so a backwards end is a date the user really typed —
    // rolling it would rewrite their answer rather than complete it.
    if (values.end.getTime() <= values.start.getTime()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "End must be after start",
      });
      return;
    }

    setSubmitting(true);
    try {
      const api = await getTrackYourTime();
      const entry = await api.create({
        description: values.description.trim(),
        projectId: orNull(values.projectId),
        taskId: orNull(values.taskId),
        tagIds: values.tagIds ?? [],
        billable: values.billable,
        start: values.start.toISOString(),
        end: values.end.toISOString(),
      });
      // The running timer is untouched, but today's total is not — the menu
      // bar can be showing it.
      await refreshMenuBar();
      await showToast({
        style: Toast.Style.Success,
        title: `Logged ${formatDurationShort(entry.durationSec)}`,
        message: entry.description || "No description",
      });
      onSaved();
      pop();
    } catch (error) {
      await showFailureToast(error, "Could not log the entry");
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
            title="Log Time"
            icon={Icon.Plus}
            onSubmit={submit}
          />
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
        // The hour that just ended — the block you are most likely logging is
        // the one you have just finished doing.
        defaultValue={new Date(range.start)}
      />
      <Form.DatePicker
        id="end"
        title="End"
        type={Form.DatePicker.Type.DateTime}
        defaultValue={new Date(range.end)}
      />
      <Form.Description text="This logs finished work — it does not touch the running timer." />
    </Form>
  );
}
