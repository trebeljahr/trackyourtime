import { ACTIVE_WORKSPACE_STORAGE_KEY } from "@starter/shared";

/** Where somebody lands after joining or leaving a workspace. */
export const WORKSPACE_LANDING = "/track/";

export type Navigate = (href: string) => void;

/** A full page load, never a client-side route change — see below. */
export const assignLocation: Navigate = (href) => {
  window.location.assign(href);
};

/**
 * Point this device at `workspaceId` and reload into the tracker.
 *
 * Deliberately a FULL navigation. Every cached query, the sync socket, the
 * running-timer mirror and the offline queue's view of "which workspace"
 * were built for the workspace just joined or left; a client-side route
 * change would keep all of them and show one workspace's data under the
 * other's permissions until each happened to refetch. A reload starts every
 * one of them from the stored choice.
 *
 * The id is written before the navigation so the next page load reads it.
 * Storage can throw (private mode, a WebView with storage disabled); the
 * server has already moved the session to the same workspace, so a failed
 * write still lands in the right place and is not worth blocking on.
 */
export const enterWorkspace = (
  workspaceId: string,
  navigate: Navigate = assignLocation,
): void => {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // See above: the session already points at this workspace.
  }
  navigate(WORKSPACE_LANDING);
};
