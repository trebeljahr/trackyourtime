import { LaunchType, Toast, launchCommand, openExtensionPreferences, showToast } from "@raycast/api";
import { ApiError, AuthError } from "../vendor/index.js";
import { NotSignedInError, StillSyncingError } from "./errors.js";
import { apiUrl } from "./preferences.js";

/**
 * Nudge the menu bar to re-read the timer.
 *
 * Menu bar commands otherwise only refresh on their interval, which would
 * leave the clock showing a timer the user just stopped from a hotkey.
 */
export async function refreshMenuBar(): Promise<void> {
  try {
    await launchCommand({ name: "menu-bar", type: LaunchType.Background });
  } catch {
    // The command is disabled, or Raycast declined to launch it. The menu bar
    // just stays stale until its next tick — not worth surfacing.
  }
}

/**
 * True when a stop/discard was refused because nothing was running any more.
 *
 * The cross-device case: the timer was stopped in the web app while this menu
 * bar item still showed it, and the user pressed Stop. They asked for a state
 * the world is already in — that is not a failure, and a red toast for it
 * teaches people to distrust the button. Matched on the server's own message
 * because a bare 404 also covers "that entry does not exist", which is a
 * genuinely different thing.
 */
export const isAlreadyStopped = (error: unknown): boolean =>
  error instanceof ApiError && error.httpStatus === 404 && error.message === "No running timer";

/**
 * "Stopped your timer in Acme", when a start stopped a timer that ran in
 * another workspace.
 *
 * The timer is the person's, so a start anywhere stops it wherever it runs.
 * Inside one workspace that is the rule everybody already expects; across two
 * it is an hour of work quietly ended somewhere the user is not looking, so
 * every start surface says so.
 */
export const replacedNotice = (entry: { replaced?: { workspaceName: string } | null }): string | undefined =>
  entry.replaced ? `Stopped your timer in ${entry.replaced.workspaceName}` : undefined;

/** True when the failure means "your token is gone or no longer valid". */
export const isAuthFailure = (error: unknown): boolean =>
  error instanceof NotSignedInError ||
  error instanceof AuthError ||
  (error instanceof ApiError && (error.httpStatus === 401 || error.code === "UNAUTHORIZED"));

/**
 * Turn a thrown value into something a human can act on.
 *
 * Node's `fetch` reports every transport failure as the bare string "fetch
 * failed" — unreachable host, refused connection, bad DNS, all identical. That
 * tells the user nothing, and the single most likely cause is the API URL
 * preference still pointing at a server that is not there, so say which URL
 * was tried and what the socket actually said.
 */
export const describeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("fetch failed")) return message;

  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code?: unknown }).code) : null;

  return `Could not reach ${apiUrl()}${code ? ` (${code})` : ""}. Check the API URL preference, and that the server is running.`;
};

const messageOf = (error: unknown): string => describeFailure(error);

/** One place that turns any thrown value into a toast the user can act on. */
export async function showFailureToast(error: unknown, title: string): Promise<void> {
  // Not a failure of the network or the server: the entry is queued on this
  // Mac and cannot be edited until it has an id the server would recognise.
  // The preferences prompt every other failure carries would be actively
  // misleading here — nothing is misconfigured.
  if (error instanceof StillSyncingError) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Not synced yet",
      message: "This entry can be edited once it reaches the server.",
    });
    return;
  }

  if (isAuthFailure(error)) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Not signed in",
      message: "Open the Timer command to pair this Mac.",
      primaryAction: {
        title: "Open Timer",
        onAction: () => {
          void launchCommand({ name: "timer", type: LaunchType.UserInitiated });
        },
      },
    });
    return;
  }

  await showToast({
    style: Toast.Style.Failure,
    title,
    message: messageOf(error),
    primaryAction: {
      title: "Open Extension Preferences",
      onAction: () => {
        void openExtensionPreferences();
      },
    },
  });
}
