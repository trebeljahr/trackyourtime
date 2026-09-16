import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import type { Tag } from "../../vendor/index.js";
import { useState } from "react";
import { getTrackYourTime } from "../../lib/api.js";
import { showFailureToast } from "../../lib/ui.js";
import { AUTOMATIC, ColorField } from "./color-field.js";

type Props = {
  /** Absent creates; present edits that tag. */
  tag?: Tag;
  onSaved?: (tag: Tag) => void;
};

export function TagForm({ tag, onSaved }: Props): React.JSX.Element {
  const { pop } = useNavigation();
  const [name, setName] = useState(tag?.name ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [color, setColor] = useState(tag?.color ?? AUTOMATIC);
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
      const saved = tag
        ? await api.updateTag({
            id: tag.id,
            name: trimmed,
            ...(color === AUTOMATIC ? {} : { color }),
          })
        : await api.createTag({
            name: trimmed,
            ...(color === AUTOMATIC ? {} : { color }),
          });

      await showToast({
        style: Toast.Style.Success,
        title: tag ? "Tag saved" : "Tag created",
        message: saved.name,
      });
      onSaved?.(saved);
      pop();
    } catch (error) {
      await showFailureToast(error, tag ? "Could not save the tag" : "Could not create the tag");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form
      isLoading={submitting}
      navigationTitle={tag ? `Edit ${tag.name}` : "New Tag"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={tag ? "Save Tag" : "Create Tag"} icon={Icon.Check} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder="deep work, invoicing, admin…"
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          if (nameError) setNameError(undefined);
        }}
      />
      <ColorField value={color} onChange={setColor} />
      <Form.Description text="Tags cut across projects — an entry can carry several, and reports can group by them." />
    </Form>
  );
}
