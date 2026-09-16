/**
 * Autocomplete for the description field.
 *
 * Raycast forms have no combo box: a `Form.TextField` cannot offer
 * completions, and a `Form.Dropdown` cannot accept a name that is not already
 * in it. So the completion is a pushed list instead — searchable, which is the
 * one thing Raycast lists are unambiguously good at — and picking a row fills
 * the field back on the form.
 */
import { Action, ActionPanel, Color, Icon, List, useNavigation } from "@raycast/api";
import { quickStartHint, type DescriptionSuggestion } from "../vendor/index.js";
import { useState } from "react";
import { formatDayHeading } from "../lib/format.js";
import { useApi } from "../lib/hooks.js";
import { SignedOutView } from "./signed-out.js";

/** Enough to scroll through without becoming a report. */
const LIMIT = 40;

/** How the list is scoped. Which one is the default depends on the form. */
type Scope = "project" | "all";

export type DescriptionPickerProps = {
  /** The composer's project, or null while it is unfiled. */
  projectId: string | null;
  /** Fill the description alone. */
  onPick: (description: string) => void;
  /**
   * Fill the description and everything the entry was last filed under.
   * Optional: the edit form offers it, a form with no fields to adopt does
   * not have to.
   */
  onAdopt?: (suggestion: DescriptionSuggestion) => void;
};

export function DescriptionPicker({ projectId, onPick, onAdopt }: DescriptionPickerProps): React.JSX.Element {
  const { pop } = useNavigation();
  // An unfiled composer opens on the whole workspace: "things I have called
  // work with no project" is a far narrower memory than the user means, and
  // usually an empty one.
  const [scope, setScope] = useState<Scope>(projectId === null ? "all" : "project");
  const [search, setSearch] = useState("");

  // Searched server-side rather than by Raycast's own filtering, because the
  // list is a page out of six months of entries — filtering the page would
  // only search the newest few dozen and quietly answer "no matches" for a
  // description that is certainly there.
  const suggestions = useApi(`descriptions:${scope}:${projectId ?? ""}:${search}`, (api) =>
    api.descriptions({
      ...(scope === "project" ? { projectId } : {}),
      ...(search.trim() === "" ? {} : { search: search.trim() }),
      limit: LIMIT,
    }),
  );

  if (suggestions.signedOut) return <SignedOutView />;

  const rows = suggestions.data ?? [];

  const use = (suggestion: DescriptionSuggestion): void => {
    onPick(suggestion.description);
    pop();
  };

  const adopt = (suggestion: DescriptionSuggestion): void => {
    onAdopt?.(suggestion);
    pop();
  };

  return (
    <List
      isLoading={suggestions.isLoading}
      // Raycast's own filter is off: what is on screen is already the answer
      // to what was typed, and filtering it again would drop rows the server
      // matched on a different part of the description.
      filtering={false}
      throttle
      searchText={search}
      onSearchTextChange={setSearch}
      searchBarPlaceholder="Search what you have tracked before…"
      searchBarAccessory={
        projectId === null ? undefined : (
          <List.Dropdown tooltip="Which entries to search" value={scope} onChange={(value) => setScope(value as Scope)}>
            <List.Dropdown.Item value="project" title="This Project" />
            <List.Dropdown.Item value="all" title="All Projects" />
          </List.Dropdown>
        )
      }
    >
      <List.EmptyView
        icon={Icon.MagnifyingGlass}
        title={search.trim() === "" ? "Nothing tracked yet" : "No match"}
        description={
          scope === "project"
            ? "Nothing under this project. Switch to all projects to search the rest."
            : "No entry has been described this way yet — type it out and it will be here next time."
        }
      />

      {rows.map((suggestion) => (
        <List.Item
          key={suggestion.description}
          icon={
            suggestion.projectColor ? { source: Icon.CircleFilled, tintColor: suggestion.projectColor } : Icon.Circle
          }
          title={suggestion.description}
          subtitle={quickStartHint(suggestion) ?? undefined}
          accessories={[
            ...(suggestion.count > 1
              ? [
                  {
                    tag: {
                      value: `${suggestion.count}×`,
                      color: Color.SecondaryText,
                    },
                  },
                ]
              : []),
            { text: formatDayHeading(suggestion.lastStart) },
          ]}
          actions={
            <ActionPanel>
              <Action title="Use Description" icon={Icon.Text} onAction={() => use(suggestion)} />
              {onAdopt ? (
                <Action
                  // The whole row, not just its name: the project, task, tags
                  // and billable flag this work was last filed under. One
                  // keystroke away rather than the default, because overwriting
                  // a project the user has already picked is the destructive
                  // reading of "autofill the name".
                  title="Use Description and Fields"
                  icon={Icon.Clipboard}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
                  onAction={() => adopt(suggestion)}
                />
              ) : null}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
