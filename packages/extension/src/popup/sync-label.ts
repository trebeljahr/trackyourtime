/**
 * What the popup says about sync, in one place.
 *
 * Lifted out of `tracker-screen.tsx` because the tracker is no longer the only
 * screen that reports it: a pushed screen shows the same verdict as a bare dot
 * in its header, and a second implementation of "when is this Offline" would
 * be a second place for the two to disagree about the same snapshot.
 */
import type { SyncStatus } from "@starter/core";
import type { PopupT } from "../i18n/use-t";

export type SyncLabel = {
  label: string;
  /** Suffix of the `.status__dot--*` modifier. */
  tone: string;
  /** The sentence behind the dot, used as its `title` where there is no room for the label. */
  title: string;
};

/**
 * "Offline" is reserved for the one case where it is true: the server did not
 * answer. A socket that is down while HTTP is fine is a real but much smaller
 * problem — other devices' changes arrive on the next poll instead of
 * instantly — and labelling it "Offline" while the toolbar was signed in and
 * saving happily was simply wrong, and unnerving with it.
 *
 * Queued work outranks both, because it is the only state where something the
 * user did has not reached the server yet.
 */
export const describeSync = (
  t: PopupT,
  status: SyncStatus,
  serverReachable: boolean,
  pending: number,
): SyncLabel => {
  if (!serverReachable) {
    return {
      label: pending > 0 ? t("sync.offlineQueued", { count: pending }) : t("sync.offline"),
      tone: "closed",
      title:
        pending > 0
          ? t("sync.offlineQueuedTitle", { count: pending })
          : t("sync.offlineTitle"),
    };
  }
  if (pending > 0) {
    return {
      label: t("sync.queued", { count: pending }),
      tone: "pending",
      title: t("sync.queuedTitle", { count: pending }),
    };
  }
  if (status === "open") {
    return { label: t("sync.synced"), tone: "open", title: t("sync.syncedTitle") };
  }
  if (status === "connecting") {
    return {
      label: t("sync.connecting"),
      tone: "connecting",
      title: t("sync.connectingTitle"),
    };
  }
  return { label: t("sync.polling"), tone: "polling", title: t("sync.pollingTitle") };
};
