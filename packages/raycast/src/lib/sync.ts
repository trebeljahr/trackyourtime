/**
 * The sync socket, for as long as Raycast keeps a command alive.
 *
 * Raycast is not a place a socket can live permanently — a view command dies
 * when it closes, and a menu bar command is unloaded the moment its first
 * render settles. But the states this extension most needs to be right about
 * are exactly the states where something IS alive: a view command open in
 * front of the user, and the menu bar item while it counts a running timer.
 * In both, a stop made in the web app, the browser extension or on another
 * machine should land now rather than on the next poll.
 *
 * When nothing is alive, the command's `interval` and `usePoll` still cover
 * it. This only ever narrows the window; it never becomes the sole path.
 */
import { useEffect, useRef, useState } from "react";
import { createSyncClient, resolveSyncUrl, syncEventReach, type SyncEvent } from "../vendor/index.js";
import { getStoredSession } from "./auth.js";
import { apiUrl } from "./preferences.js";
import { activeWorkspaceId } from "./workspace.js";
import { APP_VERSION } from "./version.js";

/**
 * Whether an event changes what the timer surfaces show. Catalog renames and
 * settings do too — a project's name and color are on the running row.
 */
const affectsTimer = (event: SyncEvent): boolean => {
  switch (event.kind) {
    case "timer.started":
    case "timer.stopped":
    case "entry.upserted":
    case "entry.deleted":
    case "favorites.changed":
    case "catalog.changed":
    case "data.imported":
    case "membership.changed":
      // A removal or a visibility change (membership.changed) can take away
      // the workspace the running row lives in.
      return true;
    case "invoice.changed":
    case "settings.changed":
    case "integrations.changed":
      // An API token or webhook subscription changing (integrations.changed)
      // alters no timer surface — it is Settings-only state, and Raycast shows
      // none of it.
      return false;
    default: {
      // A new SyncEvent kind stops this file compiling rather than silently
      // becoming a case Raycast never reacts to.
      const unhandled: never = event;
      void unhandled;
      // At runtime a newer server can still send one. Revalidating costs a
      // fetch; ignoring it could leave the menu bar on a timer that ended.
      return true;
    }
  }
};

/**
 * Revalidate whenever another surface changes the timer, and report whether
 * the socket is currently open.
 *
 * Deliberately does NOT skip this install's own `originId`. Every Raycast
 * command shares one origin id, so filtering it out would drop precisely the
 * event the menu bar needs most — the stop the user just made in the Timer
 * command, one process over. A duplicate refetch is cheap; a menu bar stuck
 * on a dead timer is the bug this exists to close.
 *
 * `enabled` is false while signed out, so a machine that has never paired
 * does not sit in a reconnect loop against a socket that will refuse it.
 */
export function useSyncRevalidate(revalidate: () => void, enabled: boolean): boolean {
  const latest = useRef(revalidate);
  latest.current = revalidate;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    // Node has had a global WebSocket since 22.4, which is what Raycast runs.
    // If a host ever lacks it, the poll is already the fallback.
    if (typeof globalThis.WebSocket === "undefined") return;

    const url = resolveSyncUrl(apiUrl(), "");
    if (url === "") return;

    let closed = false;
    let client: { close: () => void } | null = null;

    void (async () => {
      const session = await getStoredSession();
      if (closed || !session) return;
      const created = createSyncClient({
        url,
        token: session.token,
        clientVersion: APP_VERSION,
        onEvent: (event, _originId, eventWorkspaceId) => {
          if (!affectsTimer(event)) return;
          if (eventWorkspaceId === undefined) {
            latest.current();
            return;
          }
          // The socket carries every workspace the person is in. Another
          // workspace's catalog or favorites say nothing about the screen;
          // its timer events still do, because the timer is the person's.
          void activeWorkspaceId()
            .catch(() => null)
            .then((active) => {
              if (syncEventReach(event, eventWorkspaceId, active) !== "ignore") {
                latest.current();
              }
            });
        },
        // Reported so the cheaper pollers underneath can stand down while the
        // socket is carrying, and pick straight back up when it drops.
        onStatus: (status) => {
          if (closed) return;
          setOpen(status === "open");
          // A socket that connects is the clearest proof available that the
          // network is back — clearer than any poll, and earlier. Revalidating
          // re-runs the snapshot load, which drains the offline queue before
          // it reads, so work tracked with no signal goes out the moment there
          // is signal rather than on the next 20-second tick.
          if (status === "open") latest.current();
        },
      });
      created.connect();
      if (closed) created.close();
      else client = created;
    })();

    return () => {
      closed = true;
      setOpen(false);
      client?.close();
    };
  }, [enabled]);

  return open;
}
