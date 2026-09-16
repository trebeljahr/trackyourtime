import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import type { Client } from "../../vendor/index.js";
import { useState } from "react";
import { getTrackYourTime } from "../../lib/api.js";
import { showFailureToast } from "../../lib/ui.js";
import { AUTOMATIC, ColorField } from "./color-field.js";

type Props = {
  /** Absent creates; present edits that client. */
  client?: Client;
  /** Handed the saved client, so a picker can select what it just made. */
  onSaved?: (client: Client) => void;
};

export function ClientForm({ client, onSaved }: Props): React.JSX.Element {
  const { pop } = useNavigation();
  const [name, setName] = useState(client?.name ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [color, setColor] = useState(client?.color ?? AUTOMATIC);
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
      const saved = client
        ? await api.updateClient({
            id: client.id,
            name: trimmed,
            ...(color === AUTOMATIC ? {} : { color }),
          })
        : await api.createClient({
            name: trimmed,
            ...(color === AUTOMATIC ? {} : { color }),
          });

      await showToast({
        style: Toast.Style.Success,
        title: client ? "Client saved" : "Client created",
        message: saved.name,
      });
      onSaved?.(saved);
      pop();
    } catch (error) {
      // A duplicate name comes back as CONFLICT with a usable message, so the
      // toast is the whole story — no need to guess at what clashed.
      await showFailureToast(error, client ? "Could not save the client" : "Could not create the client");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form
      isLoading={submitting}
      navigationTitle={client ? `Edit ${client.name}` : "New Client"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={client ? "Save Client" : "Create Client"} icon={Icon.Check} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder="Who is paying for this work?"
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          if (nameError) setNameError(undefined);
        }}
      />
      <ColorField value={color} onChange={setColor} />
    </Form>
  );
}
