import {
  Action,
  ActionPanel,
  Icon,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { webLink } from "../lib/preferences.js";
import { SignIn } from "./sign-in.js";

/**
 * Empty state shown by every view command when there is no session yet.
 *
 * Pairing is pushed from here rather than living in a command of its own: it
 * is the wall every command hits while signed out, so it belongs where the
 * user hits it — and a root-search entry for something you run once is surface
 * for nothing. Pushed rather than rendered inline because {@link SignIn} opens
 * the approval page in a browser as soon as it mounts, which is helpful when
 * asked for and rude when it happens because a list happened to load.
 */
export function SignedOutView(): React.JSX.Element {
  return (
    <List>
      <List.EmptyView
        icon={Icon.Key}
        title="Not signed in"
        description="Pair this Mac with your Track Your Time account to start tracking from Raycast."
        actions={
          <ActionPanel>
            <Action.Push
              title="Sign in to Track Your Time"
              icon={Icon.Key}
              target={<SignIn />}
            />
            <Action.OpenInBrowser
              title="Open Web App"
              url={webLink("/app/track")}
            />
            <Action
              title="Open Extension Preferences"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
