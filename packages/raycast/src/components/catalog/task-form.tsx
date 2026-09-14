import {
  Action,
  ActionPanel,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import type { Task } from "@starter/core";
import { useState } from "react";
import { getTrackYourTime } from "../../lib/api.js";
import { showFailureToast } from "../../lib/ui.js";

type Props = {
  /** Absent creates; present edits that task. */
  task?: Task;
  onSaved?: (task: Task) => void;
};

/**
 * Create or rename a task.
 *
 * A task is a workspace-wide name for a kind of work, not a child of a
 * project — so a name is the whole form.
 */
export function TaskForm({ task, onSaved }: Props): React.JSX.Element {
  const { pop } = useNavigation();
  const [name, setName] = useState(task?.name ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [done, setDone] = useState(task?.done ?? false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("Name is required");
      return;
    }

    setSubmitting(true);
    try {
      const api = await getTrackYourTime();
      const saved = task
        ? await api.updateTask({ id: task.id, name: trimmed, done })
        : await api.createTask({ name: trimmed });

      await showToast({
        style: Toast.Style.Success,
        title: task ? "Task saved" : "Task created",
        message: saved.name,
      });
      onSaved?.(saved);
      pop();
    } catch (error) {
      await showFailureToast(
        error,
        task ? "Could not save the task" : "Could not create the task",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form
      isLoading={submitting}
      navigationTitle={task ? `Edit ${task.name}` : "New Task"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={task ? "Save Task" : "Create Task"}
            icon={Icon.Check}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder="What is the piece of work?"
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          if (nameError) setNameError(undefined);
        }}
      />
      {task ? (
        <Form.Checkbox
          id="done"
          label="Done"
          value={done}
          onChange={setDone}
          info="A done task stays selectable — it only sorts and renders differently."
        />
      ) : null}
    </Form>
  );
}
