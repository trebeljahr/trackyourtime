/**
 * Whether a `ray develop` build with empty **API URL** and **Web App URL**
 * talks to a local server instead of the hosted one.
 *
 * `true` here, in the monorepo, where the copy running under `ray develop` is
 * the one being changed and the hosted API does not have the change yet.
 * `scripts/export-store.mjs` rewrites this line to `false` in the store copy,
 * because a Store reviewer runs `npm run dev` there with empty preferences and
 * must reach the hosted service, not `localhost`. `export-store.test.mjs` pins
 * both halves.
 */
export const DEV_BUILD_USES_LOCALHOST: boolean = true;
