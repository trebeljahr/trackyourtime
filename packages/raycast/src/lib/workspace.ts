/**
 * Which workspace Raycast tracks into.
 *
 * Its own choice, in Raycast's `LocalStorage` — a preference cannot be
 * changed from a command, and the choice must be changeable from the Timer
 * view. It never follows the session's `activeOrganizationId` either: that
 * belongs to the SESSION, and a switch in the web app must not silently
 * retarget the next hotkey start here. Every request names the workspace
 * explicitly instead (`createApiClient`'s `workspaceId` getter in `api.ts`).
 *
 * Every rule about the stored record — how it parses, whose it is, how a
 * fresh list resolves it, which names are remembered — is core's
 * (`workspace-context.ts`), shared with the browser extension and tested
 * there. What is here is the store.
 *
 * Nothing is memoised in the process. The menu bar stays loaded for as long as
 * a timer ticks, and a switch made in the Timer command, one process over,
 * must reach it on its next read.
 */
import { LocalStorage } from "@raycast/api";
import {
  parseWorkspaceChoice,
  resolveActiveWorkspaceId,
  withWorkspaceList,
  workspaceChoiceFor,
  workspaceNameIn,
  workspaceScopedKey,
  type StoredWorkspaceChoice,
  type WorkspaceSummary,
} from "../vendor/index.js";
import { getStoredUserId } from "./auth.js";
import { apiUrl } from "./preferences.js";
import { raycastStorage } from "./storage.js";

const CHOICE_KEY = "trackyourtime.raycast.workspace";

/**
 * Told when the workspace changes inside THIS process — a switch from the
 * Timer view, or a fresh list replacing a workspace the account left — so the
 * view re-keys at once instead of on its next storage poll. Other processes
 * notice through that poll (`useActiveWorkspaceId`).
 */
const listeners = new Set<() => void>();

export const onWorkspaceChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notify = (): void => {
  for (const listener of listeners) listener();
};

const owner = async (): Promise<{ server: string; userId: string | null }> => ({
  server: apiUrl(),
  userId: await getStoredUserId(),
});

/** This server's and this account's choice, or an empty one. Never throws. */
export async function loadWorkspaceChoice(): Promise<StoredWorkspaceChoice> {
  try {
    const raw = await raycastStorage.getItem(CHOICE_KEY);
    return workspaceChoiceFor(parseWorkspaceChoice(raw), await owner());
  } catch {
    return parseWorkspaceChoice(null);
  }
}

const save = async (choice: StoredWorkspaceChoice): Promise<void> => {
  try {
    await raycastStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    /* storage unavailable — the next list read resolves the default again */
  }
};

/** The workspace requests are addressed to, or null before any is known. */
export async function activeWorkspaceId(): Promise<string | null> {
  const choice = await loadWorkspaceChoice();
  return resolveActiveWorkspaceId(choice.workspaceId, choice.workspaces);
}

/** The last membership list, or null when this Mac has never fetched one. */
export async function knownWorkspaces(): Promise<WorkspaceSummary[] | null> {
  return (await loadWorkspaceChoice()).workspaces;
}

/** A workspace's name, including one this person has since left. */
export async function workspaceNameLookup(): Promise<(id: string) => string | null> {
  const choice = await loadWorkspaceChoice();
  return (id) => workspaceNameIn(choice, id);
}

/**
 * Install the list the server just gave. `moved` is true when the workspace
 * requests go to changed — the chosen one is no longer a membership.
 */
export async function installWorkspaceList(
  list: readonly WorkspaceSummary[],
): Promise<{ activeId: string | null; moved: boolean }> {
  const installed = withWorkspaceList(await loadWorkspaceChoice(), list, await owner());
  await save(installed.choice);
  if (installed.moved) notify();
  return { activeId: installed.activeId, moved: installed.moved };
}

/**
 * Point Raycast at another workspace, if the last list says it is one.
 *
 * The caller refreshes the list first; this refuses anything the stored list
 * does not contain, so a removal the server already reported cannot be undone
 * by a stale action row.
 */
export async function chooseWorkspace(workspaceId: string): Promise<boolean> {
  const choice = await loadWorkspaceChoice();
  if (!choice.workspaces?.some((it) => it.id === workspaceId)) return false;
  const current = await owner();
  await save({ ...choice, ...current, workspaceId });
  notify();
  return true;
}

// ── storage that describes one workspace ─────────────────────────────

/**
 * The key for `base` in the active workspace.
 *
 * A value written before any workspace was known — by a build from before
 * workspaces, or on a Mac that has never reached the server — sits under the
 * bare key. The first read that resolves a workspace adopts it, once: that is
 * where it was made, and leaving it under the bare key would let whichever
 * workspace is chosen later inherit it.
 */
export async function workspaceKey(base: string): Promise<string> {
  const workspaceId = await activeWorkspaceId();
  const key = workspaceScopedKey(base, workspaceId);
  if (key === base) return key;
  try {
    const legacy = await raycastStorage.getItem(base);
    if (legacy !== null) {
      if ((await raycastStorage.getItem(key)) === null) {
        await raycastStorage.setItem(key, legacy);
      }
      await raycastStorage.removeItem(base);
    }
  } catch {
    /* storage unavailable — the scoped key is still the right one to use */
  }
  return key;
}

/** Remove `base` in every workspace — for a sign-out. */
export async function clearEveryWorkspace(base: string): Promise<void> {
  try {
    const items = await LocalStorage.allItems();
    for (const key of Object.keys(items)) {
      if (key === base || key.startsWith(`${base}:`)) {
        await LocalStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}
