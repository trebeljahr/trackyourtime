import { useState, type JSX } from "react";
import type { Client, Project } from "@starter/core";
import { useT } from "../i18n/use-t";
import {
  changedFields,
  ColorSwatches,
  PanelActions,
  panelKeys,
  parseRate,
  RenamePanel,
  useCatalogEdit,
} from "./catalog-edit";
import { Combobox, type ComboboxOption } from "./combobox";
import { Switch } from "./switch";
import { useSelectWhenCreated } from "./use-created-row";

/**
 * Pick a project, make one, or change one — including the client it is filed
 * under, which can itself be made or renamed from inside the panel.
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
   * True while a create or edit panel is open.
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
  const edit = useCatalogEdit();
  /** The open panel: a project being made (with its typed name) or changed. */
  const [panel, setPanel] = useState<
    { mode: "create"; name: string } | { mode: "edit"; project: Project } | null
  >(null);

  // A project made here is the project the entry wants; leaving the field
  // empty afterwards would mean picking it a second time.
  const createProject = useSelectWhenCreated(projects, (project) => {
    onChange(project.id);
  });

  const open = (next: NonNullable<typeof panel>): void => {
    setPanel(next);
    onPendingChange?.(true);
  };

  const close = (): void => {
    setPanel(null);
    onPendingChange?.(false);
  };

  if (panel === null) {
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
          open({ mode: "create", name });
        }}
        createLabel={(name) => t("fields.createProject", { name })}
        onNew={() => open({ mode: "create", name: "" })}
        newLabel={t("catalogEdit.newProject")}
        onEdit={
          edit === null
            ? undefined
            : (id) => {
                const project = projects.find((candidate) => candidate.id === id);
                if (project) open({ mode: "edit", project });
              }
        }
        editLabel={(name) => t("catalogEdit.editProject", { name })}
        testId={testId}
      />
    );
  }

  return (
    <ProjectPanel
      // Keyed so switching from one project's panel to another's starts clean.
      key={panel.mode === "edit" ? panel.project.id : "new"}
      project={panel.mode === "edit" ? panel.project : null}
      initialName={panel.mode === "create" ? panel.name : ""}
      clients={clients}
      busy={busy}
      onCreateClient={onCreateClient}
      onSave={async (fields) => {
        if (panel.mode === "edit") {
          if (edit === null) return false;
          const before = formFieldsOf(panel.project);
          const patch = changedFields(before, fields);
          if (Object.keys(patch).length === 0) return true;
          return edit.updateProject(panel.project.id, patch);
        }
        let created = false;
        await createProject(fields.name, async () => {
          const { name, clientId, ...details } = fields;
          created =
            edit === null
              ? await onCreateProject(name, clientId)
              : await edit.createProject(name, clientId, withoutUnset(details));
          return created;
        });
        return created;
      }}
      onClose={close}
      testId={`${testId}-${panel.mode === "edit" ? "edit" : "new"}`}
    />
  );
}

/** What the project panel edits, in the shape `projects.update` takes. */
type ProjectFormFields = {
  name: string;
  clientId: string | null;
  color: string | undefined;
  billableDefault: boolean;
  hourlyRate: number | null;
};

const formFieldsOf = (project: Project): ProjectFormFields => ({
  name: project.name,
  clientId: project.clientId,
  color: project.color,
  billableDefault: project.billableDefault,
  hourlyRate: project.hourlyRate,
});

/** A new project with no colour picked leaves the choice to the server. */
const withoutUnset = ({
  color,
  ...rest
}: Omit<ProjectFormFields, "name" | "clientId">): {
  color?: string;
  billableDefault: boolean;
  hourlyRate: number | null;
} => (color === undefined ? rest : { ...rest, color });

function ProjectPanel({
  project,
  initialName,
  clients,
  busy,
  onCreateClient,
  onSave,
  onClose,
  testId,
}: {
  /** `null` makes a new project. */
  project: Project | null;
  initialName: string;
  clients: Client[];
  busy: boolean;
  onCreateClient: (name: string) => Promise<boolean>;
  onSave: (fields: ProjectFormFields) => Promise<boolean>;
  onClose: () => void;
  testId: string;
}): JSX.Element {
  const t = useT("popup");
  const edit = useCatalogEdit();
  const [name, setName] = useState(project?.name ?? initialName);
  const [color, setColor] = useState(project?.color);
  const [clientId, setClientId] = useState(project?.clientId ?? null);
  // A new project is billable unless said otherwise — the server's own
  // default, so the switch shows what an untouched create would get.
  const [billableDefault, setBillableDefault] = useState(
    project?.billableDefault ?? true,
  );
  const [rate, setRate] = useState(
    project?.hourlyRate === null || project?.hourlyRate === undefined
      ? ""
      : String(project.hourlyRate),
  );
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [saving, setSaving] = useState(false);

  // Same for the client, into the panel's own field rather than the entry's.
  const createClient = useSelectWhenCreated(clients, (client) => {
    setClientId(client.id);
  });

  const parsedRate = parseRate(rate);
  const canSave = name.trim() !== "" && parsedRate !== "invalid";

  // Booked time keeps the billing it was saved with; saying so here is the
  // popup's version of the web app's "apply to existing entries?" prompt.
  const billingChanged =
    project !== null &&
    (billableDefault !== project.billableDefault ||
      (parsedRate !== "invalid" && parsedRate !== project.hourlyRate));

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    const ok = await onSave({
      name: name.trim(),
      clientId,
      color,
      billableDefault,
      hourlyRate: parsedRate,
    });
    setSaving(false);
    // Left open on failure, holding everything typed: the banner above says
    // what went wrong, and closing would make the user retype it all.
    if (ok) onClose();
  };

  return (
    <div className="panel" data-testid={testId}>
      <p className="panel__title">
        {project === null
          ? t("catalogEdit.newProjectTitle")
          : t("catalogEdit.editProjectTitle", { name: project.name })}
      </p>

      <div className="panel__fields">
        <label className="field">
          <span className="field__label">{t("catalogEdit.name")}</span>
          <input
            className="input"
            type="text"
            value={name}
            autoFocus={project !== null || initialName === ""}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={panelKeys(() => void save(), onClose)}
            data-testid={`${testId}-name`}
          />
        </label>

        <ColorSwatches
          value={color ?? null}
          onChange={setColor}
          testId={`${testId}-color`}
        />

        {editingClient === null ? (
          <Combobox
            label={t("fields.client")}
            options={clients.map((client) => ({
              id: client.id,
              label: client.name,
              color: client.color,
            }))}
            value={clientId}
            onChange={setClientId}
            emptyLabel={t("fields.noClient")}
            placeholder={t("fields.searchClients")}
            onCreate={async (clientName) => {
              await createClient(clientName, () => onCreateClient(clientName));
            }}
            createLabel={(clientName) =>
              t("fields.createClient", { name: clientName })
            }
            onEdit={
              edit === null
                ? undefined
                : (id) =>
                    setEditingClient(
                      clients.find((candidate) => candidate.id === id) ?? null,
                    )
            }
            editLabel={(clientName) =>
              t("catalogEdit.editClient", { name: clientName })
            }
            testId={`${testId}-client`}
          />
        ) : (
          <RenamePanel
            title={t("catalogEdit.editClientTitle", { name: editingClient.name })}
            row={editingClient}
            onSave={(patch) =>
              edit === null
                ? Promise.resolve(false)
                : edit.updateClient(editingClient.id, patch)
            }
            onClose={() => setEditingClient(null)}
            testId={`${testId}-client-edit`}
          />
        )}

        <Switch
          checked={billableDefault}
          onChange={setBillableDefault}
          label={
            billableDefault
              ? t("catalogEdit.billableByDefault")
              : t("catalogEdit.notBillableByDefault")
          }
          variant="struck"
          testId={`${testId}-billable`}
        />

        <label className="field">
          <span className="field__label">{t("catalogEdit.hourlyRate")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={rate}
            placeholder={t("catalogEdit.workspaceRate")}
            aria-invalid={parsedRate === "invalid"}
            onChange={(event) => setRate(event.target.value)}
            onKeyDown={panelKeys(() => void save(), onClose)}
            data-testid={`${testId}-rate`}
          />
        </label>

        {parsedRate === "invalid" && (
          <p className="panel__hint panel__hint--error">
            {t("catalogEdit.rateInvalid")}
          </p>
        )}
        {billingChanged && (
          <p className="panel__hint">{t("catalogEdit.billingNewTimeOnly")}</p>
        )}
      </div>

      <PanelActions
        saving={saving || busy}
        canSave={canSave && editingClient === null}
        onCancel={onClose}
        onSave={() => void save()}
        create={project === null}
        testId={testId}
      />
    </div>
  );
}
