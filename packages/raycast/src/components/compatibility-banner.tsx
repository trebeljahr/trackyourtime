import { Action, ActionPanel, Color, Icon, List, MenuBarExtra, open } from "@raycast/api";
import type { CompatibilityBanner } from "../lib/compatibility-copy.js";

/**
 * The "one side is too old" row, pinned above everything else in a list.
 *
 * A List has no banner slot, so it is a section of its own at the top. The
 * title is short enough for the row; the full sentence is the subtitle and the
 * tooltip, since a long subtitle truncates.
 */
export function CompatibilityListSection({
  banner,
  children,
}: {
  banner: CompatibilityBanner | null;
  /** Extra actions under the banner's own, e.g. the view's common actions. */
  children?: React.ReactNode;
}): React.JSX.Element | null {
  if (banner === null) return null;
  return (
    <List.Section title="Update needed">
      <List.Item
        icon={{ source: Icon.Warning, tintColor: Color.Red }}
        title={banner.title}
        subtitle={banner.message}
        accessories={[{ icon: Icon.Info, tooltip: banner.message }]}
        actions={
          <ActionPanel>
            {banner.url ? <Action.OpenInBrowser title="How to Update the Server" url={banner.url} /> : null}
            <Action.CopyToClipboard title="Copy Message" content={banner.message} />
            {children}
          </ActionPanel>
        }
      />
    </List.Section>
  );
}

/** The same banner as a menu bar section. */
export function CompatibilityMenuBarSection({
  banner,
}: {
  banner: CompatibilityBanner | null;
}): React.JSX.Element | null {
  if (banner === null) return null;
  const url = banner.url;
  return (
    <MenuBarExtra.Section title="Update needed">
      <MenuBarExtra.Item
        icon={{ source: Icon.Warning, tintColor: Color.Red }}
        title={banner.title}
        tooltip={banner.message}
        onAction={url ? () => void open(url) : undefined}
      />
      <MenuBarExtra.Item title={banner.message} />
    </MenuBarExtra.Section>
  );
}
