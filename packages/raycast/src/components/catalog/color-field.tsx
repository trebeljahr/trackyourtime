import { Form, Icon } from "@raycast/api";
import { CATALOG_COLORS } from "../../vendor/index.js";

/** "Let the server pick" — the same thing omitting `color` on create does. */
export const AUTOMATIC = "";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

/**
 * The catalog palette as a dropdown.
 *
 * Raycast has no color well, so the twelve palette hues are the whole range
 * here rather than a set of shortcuts around a hex field — a hex nobody can
 * see while typing is not worth the validation it would need. Anything
 * outside the palette is still editable in the web app.
 */
export function ColorField({ value, onChange }: Props): React.JSX.Element {
  // A color already on the row that is not one of ours must still be
  // selectable, or opening the form would silently repaint the thing.
  const custom = value !== AUTOMATIC && !CATALOG_COLORS.some((color) => color.hex === value.toLowerCase());

  return (
    <Form.Dropdown id="color" title="Color" value={value} onChange={onChange}>
      <Form.Dropdown.Item value={AUTOMATIC} title="Automatic" icon={Icon.Circle} />
      {custom ? (
        <Form.Dropdown.Item
          value={value}
          title={`Custom (${value})`}
          icon={{ source: Icon.CircleFilled, tintColor: value }}
        />
      ) : null}
      {CATALOG_COLORS.map((color) => (
        <Form.Dropdown.Item
          key={color.hex}
          value={color.hex}
          title={color.name}
          icon={{ source: Icon.CircleFilled, tintColor: color.hex }}
        />
      ))}
    </Form.Dropdown>
  );
}
