/**
 * The workspace this extension is pointed at, and the last membership list it
 * saw.
 *
 * The extension's OWN choice, in `chrome.storage.local`. It never follows the
 * session's `activeOrganizationId`, and that is the point: the toolbar often
 * borrows the web app's session cookie, and the session holds ONE active
 * workspace for everything signed in with it. A switch in the web app would
 * otherwise silently retarget the next start pressed here. Every request
 * names the workspace explicitly instead (`createApiClient`'s `workspaceId`
 * getter in `background/runtime.ts`).
 *
 * The list is kept beside the choice for two reasons. A cold offline start has
 * no server to ask, and still has to stamp queued rows with a workspace and
 * render the picker. And a row held for a workspace the person has since left
 * is described by the name it had, not an id — the server's list no longer
 * contains it.
 *
 * Only the service worker touches this; the popup reads it off the snapshot.
 */
import {
  emptyWorkspaceChoice,
  parseWorkspaceChoice,
  type StoredWorkspaceChoice,
} from "@starter/core";
import { chromeStorage, localStorageArea } from "./chrome-storage";

export const WORKSPACE_CHOICE_STORAGE_KEY = "trackyourtime.extension.workspace";

/** The shape and every rule about it are core's, shared with Raycast. */
export type WorkspaceChoice = StoredWorkspaceChoice;

const storage = (): ReturnType<typeof chromeStorage> =>
  chromeStorage(localStorageArea());

/** A malformed record reads as "never chosen", never as an error. */
export async function loadWorkspaceChoice(): Promise<WorkspaceChoice> {
  const raw = await storage().getItem(WORKSPACE_CHOICE_STORAGE_KEY);
  return raw === null ? emptyWorkspaceChoice() : parseWorkspaceChoice(raw);
}

export async function saveWorkspaceChoice(choice: WorkspaceChoice): Promise<void> {
  await storage().setItem(WORKSPACE_CHOICE_STORAGE_KEY, JSON.stringify(choice));
}

export async function clearWorkspaceChoice(): Promise<void> {
  await storage().removeItem(WORKSPACE_CHOICE_STORAGE_KEY);
}
