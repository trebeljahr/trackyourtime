/**
 * The five fields every trackyourtime form asks for, rendered once.
 *
 * Three Raycast forms compose an entry — start a timer, log past work, edit
 * an entry — and all three ask exactly the same five questions, because
 * `EntryFields` in `@starter/core` says those are the five things an entry is.
 * They were written out three times, and the copies had already drifted: only
 * one of them showed task durations, and none of them grouped projects by
 * client the way the web picker does.
 *
 * These are functions returning Form items rather than components wrapping
 * them, so the elements Raycast sees as `Form` children really are
 * `Form.Dropdown` and friends rather than something of ours.
 */
import { Action, Form, Icon } from "@raycast/api";
import { useEffect } from "react";
import type { ProjectWithStats, TagWithStats, TaskWithStats } from "../lib/api.js";
import { formatDurationShort } from "../lib/format.js";
import { useApi, type ApiHookResult } from "../lib/hooks.js";
import { ProjectForm } from "./catalog/project-form.js";
import { TagForm } from "./catalog/tag-form.js";
import { TaskForm } from "./catalog/task-form.js";

/** `""` is the dropdown's stand-in for "no project"/"no task". */
export const NONE = "";

/** `""` and "field absent" both mean "unassigned" by the time this ships. */
export const orNull = (value: string | undefined): string | null =>
  value && value !== NONE ? value : null;

/** The other direction: an entry's null is the dropdown's `""`. */
export const orNone = (value: string | null | undefined): string =>
  value ?? NONE;

export type EntryCatalog = {
  projects: ApiHookResult<ProjectWithStats[]>;
  tasks: ApiHookResult<TaskWithStats[]>;
  tags: ApiHookResult<TagWithStats[]>;
  /** True while any of the three is in flight — what a Form's spinner wants. */
  isLoading: boolean;
  signedOut: boolean;
};

/**
 * Everything the three field renderers below read.
 *
 * Tasks and tags are both workspace-wide: neither belongs to a project, so
 * neither reloads when the project changes.
 */
export function useEntryCatalog(): EntryCatalog {
  const projects = useApi("projects", (api) => api.projects());
  const tags = useApi("tags", (api) => api.tags());
  const tasks = useApi("tasks", (api) => api.tasks());

  return {
    projects,
    tasks,
    tags,
    isLoading: projects.isLoading || tasks.isLoading || tags.isLoading,
    signedOut: projects.signedOut,
  };
}

/**
 * Adopt a project's billable default when the project changes.
 *
 * Only for a composer — a form about to write a NEW entry, where nothing has
 * been decided yet. The edit form deliberately does not do this: the flag on
 * an existing entry is an answer somebody already gave, and a rate may already
 * have been snapshotted from it.
 *
 * A project that is not in the list yet is not an answer of "false" — it is
 * the catalog still loading — so an unknown id leaves the checkbox alone.
 */
export function useProjectBillableDefault(
  catalog: EntryCatalog,
  projectId: string,
  setBillable: (value: boolean) => void,
): void {
  const projects = catalog.projects.data;
  useEffect(() => {
    if (projectId === NONE) return;
    const project = projects?.find((candidate) => candidate.id === projectId);
    if (project) setBillable(project.billableDefault);
    // `setBillable` is a `useState` setter, which React keeps stable.
  }, [projectId, projects]);
}

/**
 * Projects grouped under their client, the way the web picker shows them.
 *
 * Two clients can each have a "Redesign", and a flat list of them is a coin
 * flip. Clients come alphabetically and the unfiled projects last, so the
 * order does not move when a project is renamed. The client name also rides
 * along as a keyword, so typing it filters to that client's projects even
 * though Raycast searches item titles only.
 */
const projectSections = (
  projects: readonly ProjectWithStats[],
): React.JSX.Element[] => {
  const byClient = new Map<string, ProjectWithStats[]>();
  for (const project of projects) {
    const key = project.clientName ?? "";
    const bucket = byClient.get(key);
    if (bucket) bucket.push(project);
    else byClient.set(key, [project]);
  }

  const named = [...byClient.keys()]
    .filter((name) => name !== "")
    .sort((a, b) => a.localeCompare(b));
  const groups = byClient.has("") ? [...named, ""] : named;

  return groups.map((clientName) => (
    <Form.Dropdown.Section
      key={clientName === "" ? "__none" : clientName}
      // A single unnamed section would be a horizontal rule with nothing to
      // say; it only earns a heading once some other client has one.
      title={clientName === "" ? (named.length > 0 ? "No client" : undefined) : clientName}
    >
      {(byClient.get(clientName) ?? []).map((project) => (
        <Form.Dropdown.Item
          key={project.id}
          value={project.id}
          title={project.name}
          keywords={clientName === "" ? undefined : [clientName]}
          icon={{ source: Icon.CircleFilled, tintColor: project.color }}
        />
      ))}
    </Form.Dropdown.Section>
  ));
};

/**
 * A dropdown holding only its own "none" row is a dead control: it looks
 * interactive, opens onto nothing, and teaches the user not to trust it. Each
 * of these three renders only once it has something to offer.
 */
export const projectField = (
  catalog: EntryCatalog,
  projectId: string,
  onChange: (value: string) => void,
): React.JSX.Element | null => {
  const projects = catalog.projects.data ?? [];
  if (projects.length === 0) return null;

  return (
    <Form.Dropdown
      id="projectId"
      title="Project"
      value={projectId}
      onChange={onChange}
    >
      <Form.Dropdown.Item value={NONE} title="No project" icon={Icon.Circle} />
      {projectSections(projects)}
    </Form.Dropdown>
  );
};

export const taskField = (
  catalog: EntryCatalog,
  taskId: string,
  onChange: (value: string) => void,
): React.JSX.Element | null => {
  const tasks = catalog.tasks.data ?? [];
  if (tasks.length === 0) return null;

  return (
    <Form.Dropdown id="taskId" title="Task" value={taskId} onChange={onChange}>
      <Form.Dropdown.Item value={NONE} title="No task" icon={Icon.Circle} />
      {tasks.map((task) => (
        <Form.Dropdown.Item
          key={task.id}
          value={task.id}
          title={
            task.totalSec > 0
              ? `${task.name} (${formatDurationShort(task.totalSec)})`
              : task.name
          }
          icon={task.done ? Icon.CheckCircle : Icon.Circle}
        />
      ))}
    </Form.Dropdown>
  );
};

export const tagsField = (
  catalog: EntryCatalog,
  tagIds: string[],
  onChange: (value: string[]) => void,
): React.JSX.Element | null => {
  const tags = catalog.tags.data ?? [];
  if (tags.length === 0) return null;

  return (
    <Form.TagPicker
      id="tagIds"
      title="Tags"
      value={tagIds}
      onChange={onChange}
      info="Tags cut across projects — an entry can carry several."
    >
      {tags.map((tag) => (
        <Form.TagPicker.Item
          key={tag.id}
          value={tag.id}
          title={tag.name}
          icon={{ source: Icon.CircleFilled, tintColor: tag.color }}
        />
      ))}
    </Form.TagPicker>
  );
};

export type CatalogActionHandlers = {
  onProject: (id: string) => void;
  onTask: (id: string) => void;
  onTag: (id: string) => void;
};

/**
 * "New project / task / tag", for the action panel of a form that files an
 * entry.
 *
 * The thing you want to file under usually does not exist yet at the moment
 * you go to file under it. Each of these pushes a form and comes back with the
 * new row already selected, so a missing project is a detour rather than a
 * dead end.
 */
export const catalogActions = (
  catalog: EntryCatalog,
  handlers: CatalogActionHandlers,
): React.JSX.Element[] => {
  const actions = [
    <Action.Push
      key="project"
      title="New Project…"
      icon={Icon.Folder}
      shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
      target={
        <ProjectForm
          onSaved={(created) => {
            handlers.onProject(created.id);
            catalog.projects.revalidate();
          }}
        />
      }
    />,
  ];

  actions.push(
    <Action.Push
      key="task"
      title="New Task…"
      icon={Icon.List}
      shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
      target={
        <TaskForm
          onSaved={(created) => {
            handlers.onTask(created.id);
            catalog.tasks.revalidate();
          }}
        />
      }
    />,
  );

  actions.push(
    <Action.Push
      key="tag"
      title="New Tag…"
      icon={Icon.Tag}
      shortcut={{ modifiers: ["cmd", "shift"], key: "g" }}
      target={
        <TagForm
          onSaved={(created) => {
            handlers.onTag(created.id);
            catalog.tags.revalidate();
          }}
        />
      }
    />,
  );

  return actions;
};
