import type { ComboboxOption } from "@/components/ui/combobox";

/** What the picker needs of a task. `projectIds` is absent from an older server. */
export type PickerTask = {
  id: string;
  name: string;
  projectIds?: string[];
};

/**
 * The task picker's options for an entry filed under `projectId`.
 *
 * A task belongs to no project, but it is weakly associated with every
 * project it has been booked on (`tasks.list`'s `projectIds`). With a project
 * picked, only that project's tasks are suggested; the rest of the workspace
 * stays findable by typing, under `otherHeading`. Hidden, not removed: task
 * names are unique per workspace, so a name typed for a task that exists
 * elsewhere must select it rather than offer to create a duplicate.
 *
 * No project, or a server too old to say which tasks go where, lists every
 * task as before. The selected task is always suggested, so the picker never
 * holds a value its list cannot show.
 */
export function taskPickerOptions(
  tasks: readonly PickerTask[],
  projectId: string | null,
  selectedId: string | null,
  otherHeading: string,
): ComboboxOption[] {
  const scoped =
    projectId !== null && tasks.every((task) => task.projectIds !== undefined);

  return tasks.map((task) => {
    const option: ComboboxOption = {
      value: task.id,
      label: task.name,
      keywords: [task.name],
    };
    if (!scoped || task.id === selectedId) return option;
    if (task.projectIds?.includes(projectId as string)) return option;
    return { ...option, group: otherHeading, searchOnly: true };
  });
}
