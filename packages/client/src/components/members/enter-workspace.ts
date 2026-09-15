import { chooseWorkspaceForNextLoad } from "@/lib/active-workspace";

/** Where somebody lands after joining or leaving a workspace. */
export const WORKSPACE_LANDING = "/app/track/";

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
 * The id is stored before the navigation so the next page load reads it,
 * through `lib/active-workspace.ts` — the same store the tRPC link, the
 * switcher and the offline queue read, which is Preferences on the native
 * shells. Storage can throw (private mode, a WebView with storage disabled);
 * the server has already moved the session to the same workspace, so a failed
 * write still lands in the right place and is not worth blocking on.
 */
export const enterWorkspace = async (
  workspaceId: string,
  navigate: Navigate = assignLocation,
): Promise<void> => {
  try {
    await chooseWorkspaceForNextLoad(workspaceId);
  } catch {
    // See above: the session already points at this workspace.
  }
  navigate(WORKSPACE_LANDING);
};
