/*
 * Where the app keeps its profile (`userData`): localStorage — and with it the
 * offline queue — cookies, session.bin, window-state.json and the
 * single-instance lock.
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
 *
 * A headless run (tests, agents; headless.ts) gets its own profile too, unless
 * one is named explicitly. Headless swaps the macOS Keychain for Chromium's
 * mock keychain, so the installed app's `session.bin` does not decrypt there —
 * and secure-store.ts deletes a ciphertext that does not decrypt. An agent
 * verifying a packaged build on the default profile would otherwise sign the
 * person who installed the app out, and replay their offline queue from a
 * window nobody can see.
 */

import path from "node:path";

export const PACKAGED_PROFILE_NAME = "trackyourtime";
export const UNPACKAGED_PROFILE_NAME = "trackyourtime-dev";
export const HEADLESS_PROFILE_SUFFIX = "-headless";

export function userDataDir(options: {
  appData: string;
  isPackaged: boolean;
  headless?: boolean;
  override?: string | undefined;
}): string {
  if (options.override) return path.resolve(options.override);
  const name = options.isPackaged ? PACKAGED_PROFILE_NAME : UNPACKAGED_PROFILE_NAME;
  return path.join(options.appData, options.headless ? `${name}${HEADLESS_PROFILE_SUFFIX}` : name);
}
