/*
 * Where the app keeps its profile (`userData`): localStorage — and with it the
 * offline queue — cookies, window-state.json and the single-instance lock.
 *
 * Pinned by name rather than left to Electron, which derives it from the
 * packaged package.json's `productName`, else `name`. Today that is the root
 * `name`, "trackyourtime"; adding a `productName` to the root package.json
 * would silently move every installed app to an empty profile and strand the
 * time queued in the old one.
 *
 * An unpackaged run (`pnpm dev:desktop`) gets its own profile. Sharing the
 * installed app's meant sharing its single-instance lock too: with the
 * installed app open, `dev:desktop` exited at once without a word.
 */

import path from "node:path";

export const PACKAGED_PROFILE_NAME = "trackyourtime";
export const UNPACKAGED_PROFILE_NAME = "trackyourtime-dev";

export function userDataDir(options: {
  appData: string;
  isPackaged: boolean;
  override?: string | undefined;
}): string {
  if (options.override) return path.resolve(options.override);
  return path.join(options.appData, options.isPackaged ? PACKAGED_PROFILE_NAME : UNPACKAGED_PROFILE_NAME);
}
