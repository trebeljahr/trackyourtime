import type { JSX } from "react";
import type { Tag } from "@starter/core";
import { useT } from "../i18n/use-t";
import { Combobox } from "./combobox";
import { useSelectWhenCreated } from "./use-created-row";

/**
 * Multi-select tags, built out of the single-select {@link Combobox} rather
 * than beside it.
 *
 * The picker only ever offers tags that are NOT already on the entry, and a
 * pick means "add this one". That keeps one search-and-create control in the
 * extension instead of two, and the selected tags render as removable chips
 * above it — at 380px a list of checkboxes would push Start off the popup.
 */

export type TagPickerProps = {
  tags: Tag[];
  value: string[];
  onChange: (tagIds: string[]) => void;
  /**
   * Creates the tag server-side. The parent re-renders with it available and
   * this picker then puts it ON the entry — creating a tag from here is a
   * request for that tag, not for a row in a list.
   */
  onCreate: (name: string) => Promise<boolean>;
  testId?: string;
};

export function TagPicker({
  tags,
  value,
  onChange,
  onCreate,
  testId = "tracker-tags",
}: TagPickerProps): JSX.Element {
  const t = useT("popup");
  const createTag = useSelectWhenCreated(tags, (tag) => {
    // Guarded, because nothing stops the same name being created twice from
    // two surfaces before either snapshot lands.
    if (value.includes(tag.id)) return;
    onChange([...value, tag.id]);
  });

  const selectedIds = new Set(value);
  const selected = value
    .map((id) => tags.find((tag) => tag.id === id))
    .filter((tag): tag is Tag => tag !== undefined);

  return (
    <div className="field">
      {selected.length > 0 && (
        <div className="tags" data-testid={`${testId}-selected`}>
          {selected.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="tag"
              style={{ borderColor: tag.color }}
              title={t("tagPicker.remove", { name: tag.name })}
              onClick={() =>
                onChange(value.filter((id) => id !== tag.id))
              }
              data-testid={`${testId}-remove-${tag.id}`}
            >
              <span className="tag__label">{tag.name}</span>
              <span aria-hidden="true" className="tag__x">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      <Combobox
        label={t("fields.tags")}
        // Already-chosen tags are filtered out: offering one that is on the
        // entry would look selectable and then do nothing.
        options={tags
          .filter((tag) => !selectedIds.has(tag.id))
          .map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
        // Always null: this control adds, it never displays a "current" tag.
        value={null}
        onChange={(id) => {
          if (id !== null) onChange([...value, id]);
        }}
        placeholder={
          selected.length === 0 ? t("tagPicker.search") : t("tagPicker.addAnother")
        }
        onCreate={async (name) => {
          await createTag(name, () => onCreate(name));
        }}
        createLabel={(name) => t("tagPicker.create", { name })}
        testId={testId}
      />
    </div>
  );
}
