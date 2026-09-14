import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import type { Project } from "@starter/core";
import { useState } from "react";
import { getTrackYourTime, type ProjectWithStats } from "../../lib/api.js";
import { NONE, parseOptionalNumber } from "../../lib/catalog.js";
import { useApi } from "../../lib/hooks.js";
import { showFailureToast } from "../../lib/ui.js";
import { AUTOMATIC, ColorField } from "./color-field.js";
import { ClientForm } from "./client-form.js";

type Props = {
  /** Absent creates; present edits that project. */
  project?: Project | ProjectWithStats;
  /** Pre-selected client for a create — filing from a client's own list. */
  clientId?: string;
  onSaved?: (project: Project) => void;
};

/** Money and hours arrive as text; empty means "no target", not zero. */
const numberField = (value: number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/**
 * Create or edit a project.
 *
 * Carries the fields that change what a timer does — client, colour, billable
 * default, rate — plus the two budget targets. Recurring budgets and the
 * per-project idle behaviour stay in the web app: both need more explanation
 * than a Raycast form can carry, and neither is something you set from a
 * launcher mid-flow.
 */
export function ProjectForm({
  project,
  clientId,
  onSaved,
}: Props): React.JSX.Element {
  const { pop } = useNavigation();
  const [name, setName] = useState(project?.name ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [color, setColor] = useState(project?.color ?? AUTOMATIC);
  const [client, setClient] = useState(
    project?.clientId ?? clientId ?? NONE,
  );
  const [billableDefault, setBillableDefault] = useState(
    project?.billableDefault ?? false,
  );
  const [hourlyRate, setHourlyRate] = useState(
    numberField(project?.hourlyRate),
  );
  const [estimatedHours, setEstimatedHours] = useState(
    numberField(project?.estimatedHours),
  );
  const [budgetAmount, setBudgetAmount] = useState(
    numberField(project?.budgetAmount),
  );
  const [submitting, setSubmitting] = useState(false);

  const clients = useApi("clients", (api) => api.clients());

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("Name is required");
      return;
    }

    const rate = parseOptionalNumber(hourlyRate);
    const hours = parseOptionalNumber(estimatedHours);
    const budget = parseOptionalNumber(budgetAmount);
    if (!rate.ok || !hours.ok || !budget.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Rate, estimate and budget must be numbers",
        message: "Leave a field empty to clear it.",
      });
      return;
    }

    // Null, not undefined: on an update an absent field means "leave it
    // alone", so clearing a rate has to say so explicitly.
    const fields = {
      name: trimmed,
      clientId: client === NONE ? null : client,
      billableDefault,
      hourlyRate: rate.value,
      estimatedHours: hours.value,
      budgetAmount: budget.value,
      ...(color === AUTOMATIC ? {} : { color }),
    };

    setSubmitting(true);
    try {
      const api = await getTrackYourTime();
      const saved = project
        ? await api.updateProject({ id: project.id, ...fields })
        : await api.createProject(fields);

      await showToast({
        style: Toast.Style.Success,
        title: project ? "Project saved" : "Project created",
        message: saved.name,
      });
      onSaved?.(saved);
      pop();
    } catch (error) {
      await showFailureToast(
        error,
        project ? "Could not save the project" : "Could not create the project",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form
      isLoading={clients.isLoading || submitting}
      navigationTitle={project ? `Edit ${project.name}` : "New Project"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={project ? "Save Project" : "Create Project"}
            icon={Icon.Check}
            onSubmit={submit}
          />
          {/* The client you want rarely exists yet when you are filing a new
              project, and bouncing out to another command to make one loses
              everything typed so far. */}
          <Action.Push
            title="New Client…"
            icon={Icon.PersonCircle}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            target={
              <ClientForm
                onSaved={(created) => {
                  setClient(created.id);
                  clients.revalidate();
                }}
              />
            }
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder="What is the work?"
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          if (nameError) setNameError(undefined);
        }}
      />
      <Form.Dropdown
        id="clientId"
        title="Client"
        value={client}
        onChange={setClient}
      >
        <Form.Dropdown.Item value={NONE} title="No client" icon={Icon.Circle} />
        {(clients.data ?? []).map((candidate) => (
          <Form.Dropdown.Item
            key={candidate.id}
            value={candidate.id}
            title={candidate.name}
            icon={{ source: Icon.CircleFilled, tintColor: candidate.color }}
          />
        ))}
      </Form.Dropdown>
      <ColorField value={color} onChange={setColor} />
      <Form.Checkbox
        id="billableDefault"
        label="Billable by default"
        value={billableDefault}
        onChange={setBillableDefault}
        info="New timers on this project start billable. Entries keep the flag they were tracked with."
      />
      <Form.Separator />
      <Form.TextField
        id="hourlyRate"
        title="Hourly Rate"
        placeholder="Workspace default"
        value={hourlyRate}
        onChange={setHourlyRate}
        info="Overrides the workspace rate. Empty clears the override; entries keep the rate they were tracked at."
      />
      <Form.TextField
        id="estimatedHours"
        title="Estimated Hours"
        placeholder="No estimate"
        value={estimatedHours}
        onChange={setEstimatedHours}
        info="Lifetime estimate, e.g. 80 for two quoted weeks. Empty is no estimate, which is not the same as zero."
      />
      <Form.TextField
        id="budgetAmount"
        title="Budget"
        placeholder="No budget"
        value={budgetAmount}
        onChange={setBudgetAmount}
        info="Lifetime money budget, in the workspace currency."
      />
    </Form>
  );
}
