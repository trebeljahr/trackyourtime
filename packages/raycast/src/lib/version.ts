/**
 * This extension's release, sent as `x-trackyourtime-client-version` so
 * Settings → Devices can say "Raycast · 0.3.1".
 *
 * Hand-kept, unlike the web app and the browser extension, which read the root
 * package.json at build time: a Raycast Store submission is this directory on
 * its own, where `../../package.json` does not exist, and `ray build` offers no
 * define. `scripts/lib/version-sync.test.mjs` fails the moment this and the
 * root version disagree, so a release bump cannot forget it.
 */
export const APP_VERSION = "0.1.0";
