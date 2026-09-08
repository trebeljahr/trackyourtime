/**
 * How long a signed-in session lives — **per client kind**, not one number
 * for everyone.
 *
 * Its own module so the numbers, the reasoning and the tests that pin them sit
 * together, and so nothing has to construct a better-auth instance (and a
 * database connection) to assert on them.
 *
 * ## Two windows, and why
 *
 * Seven days is wrong for a phone. A session is only extended when
 * `getSession` runs, so a device left in a drawer over a holiday comes back to
 * a session row the next lookup deletes — and a native client that kept
 * working offline against a stored token then replays a queue of genuinely
 * tracked time into 401s. Thirty days makes the ordinary gap (a week away, a
 * phone in a drawer) survivable.
 *
 * Thirty days is wrong for a browser. A laptop that signs in on a borrowed
 * machine and is never touched again should not stay signed in for a month,
 * and nothing about a browser needs the long window: it is opened by hand,
 * and reaching the app at all means a `getSession` that rolls the window
 * forward. So browser cookie sessions keep better-auth's seven-day default.
 *
 * ## How the split is enforced
 *
 * better-auth 1.6.11's `session.expiresIn` is a single global `number` — see
 * `@better-auth/core/dist/types/init-options.d.mts:759`, which types it
 * `expiresIn?: number` with no function form. It is read in three places:
 *
 *  - `better-auth/dist/db/internal-adapter.mjs:177` — the `expiresAt` of a
 *    newly created session row,
 *  - `better-auth/dist/api/routes/session.mjs:217` and `:237` — whether a
 *    session is due for a refresh, and the `expiresAt` it is refreshed to,
 *  - `better-auth/dist/cookies/index.mjs:126` — the `max-age` of the browser
 *    session cookie at sign-in.
 *
 * The first two are overridable, and that is enough. `createWithHooks` and
 * `updateWithHooks` (`better-auth/dist/db/with-hooks.mjs`) merge whatever a
 * `databaseHooks.session.{create,update}.before` hook returns over the row
 * better-auth was about to write — `expiresAt` included. So the create hook
 * writes the window for the client that signed in, and the update hook writes
 * it again on every refresh, which is what stops a shortened row being
 * silently restored to the global value the first time it is used. Both are
 * wired in `auth/auth.ts` and the pure decisions live in `auth/session-hooks.ts`.
 *
 * The global stays at the **long** value on purpose, and it is the one thing
 * here that is not free to choose:
 *
 *  - the refresh trigger is `expiresAt - expiresIn + updateAge <= now`
 *    (`session.mjs:217`) — computed against the *global*. A 30-day row under a
 *    7-day global would not be refreshed until it had six days left, so a
 *    token client's real inactivity tolerance would collapse from thirty days
 *    to six. With the global at thirty, token clients behave exactly as they
 *    did before this split existed, and the shortened browser rows are the
 *    ones that always look due — which is correct, since a rolling seven-day
 *    window is precisely what they should have.
 *  - `max-age` on the sign-in cookie is the global, so a browser's cookie
 *    initially outlives its row. That direction is the safe one: the server
 *    row is the authority, an expired row is deleted and its cookie cleared on
 *    the next request, and the first refresh rewrites the cookie from the real
 *    `expiresAt` (`session.mjs:246`). The reverse — a row outliving its cookie
 *    — is what would leave a signed-out-looking browser holding a live session.
 */
import type { ClientKind } from "@starter/shared";

/**
 * Thirty days, for clients that carry their session as a stored token: the
 * mobile and desktop shells, Raycast, the browser extension, the CLI. These
 * are the clients that go unopened for a week and then expect their offline
 * queue to replay rather than 401.
 */
export const TOKEN_CLIENT_SESSION_SECONDS = 60 * 60 * 24 * 30;

/**
 * Seven days — better-auth's own default — for browser cookie sessions, and
 * for any session whose client did not identify itself. Unknown falls on this
 * side deliberately: the short window is the conservative one, so a client
 * that forgets to name itself loses convenience, never safety.
 */
export const BROWSER_SESSION_SECONDS = 60 * 60 * 24 * 7;

/**
 * How stale a session row may get before a request rewrites its expiry.
 *
 * It only bites the long window: a browser row is always shorter than the
 * global `expiresIn`, so it is refreshed whenever a lookup reaches the
 * database at all (the five-minute cookie cache is what keeps that from being
 * every request). For a token client this is what it says — one write a day
 * per active session rather than one per request.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/** Client kinds that keep a session alive for {@link TOKEN_CLIENT_SESSION_SECONDS}. */
const TOKEN_CLIENTS: ReadonlySet<ClientKind> = new Set<ClientKind>([
  "mobile",
  "desktop",
  "raycast",
  "extension",
  "cli",
]);

/**
 * Does this client carry its session as a stored token rather than a cookie?
 *
 * Cosmetic-adjacent, like every other use of `ClientKind`: it is self-reported,
 * so the worst a caller can do by lying is give **its own** session a longer
 * window than it needed — the same window it would have got by signing in from
 * a native client for real. It is never an authorization decision.
 */
export function isTokenClient(client: ClientKind): boolean {
  return TOKEN_CLIENTS.has(client);
}

/** The session window, in seconds, for a client of this kind. */
export function sessionExpiresInSeconds(client: ClientKind): number {
  return isTokenClient(client)
    ? TOKEN_CLIENT_SESSION_SECONDS
    : BROWSER_SESSION_SECONDS;
}

/** When a session created (or refreshed) now, by this client, should expire. */
export function sessionExpiresAt(
  client: ClientKind,
  now: number = Date.now(),
): Date {
  return new Date(now + sessionExpiresInSeconds(client) * 1000);
}
