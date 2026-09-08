/**
 * Per-client session windows, against the real better-auth.
 *
 * `session-lifetime.test.ts` pins the policy — which client gets which number,
 * and which field the decision is read from. It cannot pin the only claim that
 * actually matters, which is that better-auth **honours** what the hooks
 * return. That claim was previously written down the other way round ("there
 * is no clean hook for it in better-auth 1.6.11"), was derived from reading the
 * source rather than running it, and was wrong. Deriving it again would repeat
 * the mistake, so this file runs it.
 *
 * It uses better-auth's in-memory adapter (a hard dependency of better-auth
 * itself, so no new package) and the same `session-hooks.ts` functions
 * `auth/auth.ts` wires in — no Mongo, no network, no fixtures.
 *
 * The two branches it has to keep apart:
 *
 *  - **create** — `internal-adapter.mjs` builds `expiresAt` from the global
 *    `expiresIn` and `createWithHooks` merges the hook's return over it.
 *  - **refresh** — `api/routes/session.mjs` re-expires a session to the global
 *    `expiresIn` again. Without the update hook a shortened row silently comes
 *    back at thirty days the first time it is used, which is the failure mode
 *    that makes a create-only fix look like it works.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";

import {
  clientKindForNewSession,
  expiryForNewSession,
  expiryForSessionRefresh,
} from "../auth/session-hooks.js";
import {
  BROWSER_SESSION_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  TOKEN_CLIENT_SESSION_SECONDS,
} from "../auth/session-lifetime.js";

type SessionRow = {
  id: string;
  token: string;
  userId: string;
  client: string;
  expiresAt: Date;
  updatedAt: Date;
};

type MemoryDb = {
  user: unknown[];
  session: SessionRow[];
  account: unknown[];
  verification: unknown[];
};

const db: MemoryDb = { user: [], session: [], account: [], verification: [] };

/**
 * The same config `auth/auth.ts` builds, cut down to what a session window
 * depends on: the global `expiresIn`, the `client` additional field, the
 * bearer plugin (so a token client can be driven without a cookie jar) and the
 * two hooks. Everything else — Mongo, Stripe, organizations, email — is
 * irrelevant to when a row expires and would only add ways for this to fail
 * for reasons that are not the subject.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

before(() => {
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: "session-lifetime-integration-secret-0123456789",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    session: {
      expiresIn: TOKEN_CLIENT_SESSION_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
      additionalFields: {
        client: {
          type: "string",
          required: false,
          defaultValue: "unknown",
          input: false,
        },
      },
    },
    plugins: [bearer()],
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => ({
            data: {
              ...session,
              client: clientKindForNewSession(context),
              expiresAt: expiryForNewSession(context),
            },
          }),
        },
        update: {
          before: async (update, context) => {
            const expiresAt = expiryForSessionRefresh(update, context);
            return expiresAt ? { data: { ...update, expiresAt } } : undefined;
          },
        },
      },
    },
  });
});

const DAY_MS = 86_400_000;

/** Whole days between now and `when`, rounded — the windows are days apart. */
const daysOut = (when: Date | string): number =>
  Math.round((new Date(when).getTime() - Date.now()) / DAY_MS);

let seq = 0;

async function signUp(
  clientHeader: string | null,
): Promise<{ token: string; row: SessionRow }> {
  seq += 1;
  const email = `session-lifetime-${seq}@example.com`;
  const response = await auth.api.signUpEmail({
    body: { email, password: "password1234", name: `user ${seq}` },
    headers: new Headers(
      clientHeader ? { "x-tracktime-client": clientHeader } : {},
    ),
    returnHeaders: true,
  });
  const token = response.headers.get("set-auth-token");
  assert.ok(token, "the bearer plugin should hand back a session token");
  return { token, row: db.session.at(-1) as SessionRow };
}

const rowFor = (id: string): SessionRow =>
  db.session.find((row) => row.id === id) as SessionRow;

/**
 * Put a session inside better-auth's refresh window without waiting days for
 * it. The trigger is `expiresAt - expiresIn + updateAge <= now`, so a row with
 * a day left is due whichever window it belongs to.
 */
const makeDueForRefresh = (row: SessionRow): void => {
  rowFor(row.id).expiresAt = new Date(Date.now() + DAY_MS);
  rowFor(row.id).updatedAt = new Date(Date.now() - 2 * DAY_MS);
};

const useSession = (token: string, clientHeader: string | null) =>
  auth.api.getSession({
    headers: new Headers({
      authorization: `Bearer ${token}`,
      ...(clientHeader ? { "x-tracktime-client": clientHeader } : {}),
    }),
    // The cookie cache would answer without ever reaching the row, which is
    // exactly the path a refresh is not on.
    query: { disableCookieCache: true },
  });

describe("better-auth honours the per-client session window", () => {
  it("is only saying anything while the two windows differ", () => {
    // Every assertion below is expressed in terms of the two constants, so
    // that it reads as "the browser window" rather than as a magic 7. Collapse
    // the constants onto each other and all of them would pass while proving
    // nothing — this is the spec that notices.
    assert.ok(
      BROWSER_SESSION_SECONDS < TOKEN_CLIENT_SESSION_SECONDS,
      "the browser window must be the shorter of the two, or there is no split",
    );
  });

  it("creates a browser session with seven days, not the global thirty", async () => {
    const { row } = await signUp("web");
    assert.equal(row.client, "web");
    assert.equal(daysOut(row.expiresAt), BROWSER_SESSION_SECONDS / 86_400);
  });

  it("creates a mobile session with thirty", async () => {
    const { row } = await signUp("tracktime-mobile");
    assert.equal(row.client, "mobile");
    assert.equal(
      daysOut(row.expiresAt),
      TOKEN_CLIENT_SESSION_SECONDS / 86_400,
    );
  });

  it("creates a Raycast session with thirty", async () => {
    const { row } = await signUp("tracktime-raycast");
    assert.equal(row.client, "raycast");
    assert.equal(
      daysOut(row.expiresAt),
      TOKEN_CLIENT_SESSION_SECONDS / 86_400,
    );
  });

  it("gives an unlabelled client the short window", async () => {
    const { row } = await signUp(null);
    assert.equal(row.client, "unknown");
    assert.equal(daysOut(row.expiresAt), BROWSER_SESSION_SECONDS / 86_400);
  });

  it("keeps a browser session at seven days across a refresh", async () => {
    // The whole point of the update hook. better-auth re-expires a refreshed
    // session to the global `expiresIn`; without the hook this comes back 30.
    const { token, row } = await signUp("web");
    makeDueForRefresh(row);
    await useSession(token, "web");
    assert.equal(
      daysOut(rowFor(row.id).expiresAt),
      BROWSER_SESSION_SECONDS / 86_400,
    );
  });

  it("keeps a mobile session at thirty days across a refresh", async () => {
    const { token, row } = await signUp("tracktime-mobile");
    makeDueForRefresh(row);
    await useSession(token, "tracktime-mobile");
    assert.equal(
      daysOut(rowFor(row.id).expiresAt),
      TOKEN_CLIENT_SESSION_SECONDS / 86_400,
    );
  });

  it("keeps a mobile session at thirty when the request names no client", async () => {
    // The WebSocket liveness re-check replays the handshake's headers, and a
    // handshake carries no `x-tracktime-client`. Deciding from the request
    // rather than from the row would quietly demote every socketed phone.
    const { token, row } = await signUp("tracktime-mobile");
    makeDueForRefresh(row);
    await useSession(token, null);
    assert.equal(
      daysOut(rowFor(row.id).expiresAt),
      TOKEN_CLIENT_SESSION_SECONDS / 86_400,
    );
  });

  it("will not let a browser session claim the long window on a refresh", async () => {
    const { token, row } = await signUp("web");
    makeDueForRefresh(row);
    await useSession(token, "tracktime-mobile");
    assert.equal(
      daysOut(rowFor(row.id).expiresAt),
      BROWSER_SESSION_SECONDS / 86_400,
    );
  });

  it("still reports a deleted session as gone when refresh is disabled", async () => {
    // `ws/auth.ts` asks with `disableRefresh` so the liveness probe stops
    // renewing what it is only meant to be checking. That flag must not also
    // turn the probe into a cache read, or a revoked device keeps its socket.
    const { token, row } = await signUp("tracktime-mobile");
    const alive = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    assert.ok(alive?.user, "a live session should still answer");

    const index = db.session.findIndex((candidate) => candidate.id === row.id);
    db.session.splice(index, 1);
    const gone = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    assert.equal(gone, null);
  });
});
