import { LaunchType, launchCommand } from "@raycast/api";
import { raycastStorage } from "./storage.js";

const ACTION_KEY = "trackyourtime.timer-action-started";
const ACTION_TIMEOUT_MS = 60_000;

/** Avoid refreshing a command while it is handling a user's timer action. */
export const timerActionBusy = async (): Promise<boolean> => {
  const started = Number(await raycastStorage.getItem(ACTION_KEY).catch(() => null));
  return started > 0 && Date.now() - started < ACTION_TIMEOUT_MS;
};

export const markTimerAction = async (active: boolean): Promise<void> => {
  await (active ? raycastStorage.setItem(ACTION_KEY, String(Date.now())) : raycastStorage.removeItem(ACTION_KEY)).catch(
    () => undefined,
  );
};

/** The menu bar owns periodic refresh; Timer itself keeps a normal Run action. */
export const refreshTimerSearch = async (): Promise<void> => {
  if (await timerActionBusy()) return;
  await launchCommand({ name: "timer", type: LaunchType.Background }).catch(() => undefined);
};
