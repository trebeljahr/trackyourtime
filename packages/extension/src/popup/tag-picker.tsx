import { useState, type JSX } from "react";
import type { Tag } from "@starter/core";
import { useT } from "../i18n/use-t";
import { RenamePanel, useCatalogEdit } from "./catalog-edit";
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
  /** True while a create or edit panel is open; see `ProjectPicker`. */
  onPendingChange?: (pending: boolean) => void;
  testId?: string;
};

export function TagPicker({
  tags,
  value,
  onChange,
  onCreate,
  onPendingChange,
  testId = "tracker-tags",
}: TagPickerProps): JSX.Element {
  const t = useT("popup");
  const edit = useCatalogEdit();
  const [panel, setPanel] = useState<
    { mode: "create" } | { mode: "edit"; tag: Tag } | null
  >(null);

  const open = (next: NonNullable<typeof panel>): void => {
    setPanel(next);
    onPendingChange?.(true);
  };

  const close = (): void => {
    setPanel(null);
    onPendingChange?.(false);
  };
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
            <span key={tag.id} className="tag-chip">
              <button
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
              {edit !== null && panel === null && (
                <button
                  type="button"
                  className="tag-chip__edit"
                  title={t("catalogEdit.editTag", { name: tag.name })}
                  aria-label={t("catalogEdit.editTag", { name: tag.name })}
                  onClick={() => open({ mode: "edit", tag })}
                  data-testid={`${testId}-pencil-${tag.id}`}
                >
                  ✎
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {panel?.mode === "create" ? (
        <RenamePanel
          title={t("catalogEdit.newTagTitle")}
          row={{ id: "", name: "" }}
          create
          onSave={async ({ name }) => {
            if (name === undefined) return false;
            let created = false;
            await createTag(name, async () => {
              created = await onCreate(name);
              return created;
            });
            return created;
          }}
          onClose={close}
          testId={`${testId}-new`}
        />
      ) : panel?.mode === "edit" ? (
        <RenamePanel
          title={t("catalogEdit.editTagTitle", { name: panel.tag.name })}
          row={panel.tag}
          onSave={(patch) =>
            edit === null ? Promise.resolve(false) : edit.updateTag(panel.tag.id, patch)
          }
          onClose={close}
          testId={`${testId}-edit`}
        />
      ) : (
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
          onNew={() => open({ mode: "create" })}
          newLabel={t("catalogEdit.newTag")}
          // Only tags not on the entry are listed; one that is has its pencil
          // beside its chip above.
          onEdit={
            edit === null
              ? undefined
              : (id) => {
                  const tag = tags.find((candidate) => candidate.id === id);
                  if (tag) open({ mode: "edit", tag });
                }
          }
          editLabel={(name) => t("catalogEdit.editTag", { name })}
          testId={testId}
        />
      )}
    </div>
  );
}
