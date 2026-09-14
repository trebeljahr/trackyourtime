import { useState, type JSX } from "react";
import type { Client, Project } from "@starter/core";
import { useT } from "../i18n/use-t";
import { Combobox, type ComboboxOption } from "./combobox";
import { useSelectWhenCreated } from "./use-created-row";

/**
 * Pick a project, or make one — including the client it is filed under.
 *
 * Two fields, so it cannot be done from inside the picker the way a tag or a
 * task can: naming the project is step one, filing it under a client is step
 * two, and the second step is where a client can be created too. The panel
 * replaces the picker rather than sitting beside it, because at 380px there is
 * no beside.
 *
 * Shared by the tracker's composer and both entry forms. Reaching for a
 * project that does not exist yet is the ordinary case at the start of a piece
 * of work, and it is no less ordinary when the work is being logged after the
 * fact — being sent to the web app for it defeats a toolbar button either way.
 */

export type ProjectPickerProps = {
  projects: Project[];
  clients: Client[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  disabledHint?: string;
  /** Busy elsewhere — the panel's own buttons are locked out. */
  busy?: boolean;
  onCreateClient: (name: string) => Promise<boolean>;
  onCreateProject: (name: string, clientId: string | null) => Promise<boolean>;
  /**
   * True while the panel is open.
   *
   * The surrounding form has a submit button, and submitting mid-panel would
   * start or save an entry against the project the user is still describing.
   */
  onPendingChange?: (pending: boolean) => void;
  testId: string;
};

const clientName = (
  clients: Client[],
  clientId: string | null,
): string | undefined =>
  clients.find((candidate) => candidate.id === clientId)?.name;

export const projectOptions = (
  projects: Project[],
  clients: Client[],
): ComboboxOption[] =>
  projects.map((project) => ({
    id: project.id,
    label: project.name,
    color: project.color,
    hint: clientName(clients, project.clientId),
  }));

export function ProjectPicker({
  projects,
  clients,
  value,
  onChange,
  disabled = false,
  disabledHint,
  busy = false,
  onCreateClient,
  onCreateProject,
  onPendingChange,
  testId,
}: ProjectPickerProps): JSX.Element {
  const t = useT("popup");
  /** Set while a new project is being named, holding the client to file it under. */
  const [pending, setPending] = useState<string | null>(null);
  const [pendingClientId, setPendingClientId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // A project made here is the project the entry wants; leaving the field
  // empty afterwards would mean picking it a second time.
  const createProject = useSelectWhenCreated(projects, (project) => {
    onChange(project.id);
  });

  // Same for the client, into the panel's own field rather than the entry's.
  const createClient = useSelectWhenCreated(clients, (client) => {
    setPendingClientId(client.id);
  });

  const openPanel = (name: string): void => {
    setPending(name);
    setPendingClientId(null);
    onPendingChange?.(true);
  };

  const closePanel = (): void => {
    setPending(null);
    setPendingClientId(null);
    onPendingChange?.(false);
  };

  const confirm = async (): Promise<void> => {
    if (pending === null) return;
    setCreating(true);
    let created = false;
    await createProject(pending, async () => {
      created = await onCreateProject(pending, pendingClientId);
      return created;
    });
    setCreating(false);
    // Left open on failure, holding the name and the client: the banner above
    // says what went wrong, and closing would make the user retype both.
    if (created) closePanel();
  };

  if (pending === null) {
    return (
      <Combobox
        label={t("fields.project")}
        options={projectOptions(projects, clients)}
        value={value}
        onChange={onChange}
        emptyLabel={t("fields.noProject")}
        placeholder={t("fields.searchProjects")}
        disabled={disabled}
        disabledHint={disabledHint}
        onCreate={async (name) => {
          openPanel(name);
        }}
        createLabel={(name) => t("fields.createProject", { name })}
        testId={testId}
      />
    );
  }

  return (
    <div className="panel" data-testid={`${testId}-new`}>
      <p className="panel__title">{t("projectPicker.newTitle", { name: pending })}</p>

      <Combobox
        label={t("fields.client")}
        options={clients.map((client) => ({
          id: client.id,
          label: client.name,
          color: client.color,
        }))}
        value={pendingClientId}
        onChange={setPendingClientId}
        emptyLabel={t("fields.noClient")}
        placeholder={t("fields.searchClients")}
        onCreate={async (name) => {
          await createClient(name, () => onCreateClient(name));
        }}
        createLabel={(name) => t("fields.createClient", { name })}
        testId={`${testId}-new-client`}
      />

      <div className="panel__actions">
        <button
          className="button"
          type="button"
          onClick={closePanel}
          disabled={busy || creating}
          data-testid={`${testId}-new-cancel`}
        >
          {t("actions.cancel")}
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={() => {
            void confirm();
          }}
          disabled={busy || creating}
          data-testid={`${testId}-new-create`}
        >
          {creating ? t("actions.creating") : t("actions.create")}
        </button>
      </div>
    </div>
  );
}
