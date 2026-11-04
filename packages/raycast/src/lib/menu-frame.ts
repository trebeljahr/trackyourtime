/**
 * The start of the timer the native item last showed.
 *
 * A fresh load cannot use its cached snapshot until the session has been read
 * from storage, which takes a moment. This synchronous copy keeps the clock in
 * the title during that moment. It holds a timestamp and no account data.
 */
import { Cache } from "@raycast/api";

const KEY = "menu-bar.running-start";
const cache = new Cache();

export const lastRunningStart = (): string | null => cache.get(KEY) ?? null;

export const rememberRunningStart = (start: string | null): void => {
  if (start === null) cache.remove(KEY);
  else cache.set(KEY, start);
};
