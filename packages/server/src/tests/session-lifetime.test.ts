/**
 * The session window is thirty days for a stored-token client and seven for a
 * browser, and the split is the point.
 *
 * The number arrived as a mobile fix — a phone left in a drawer over a holiday
 * comes back to a deleted session and replays a day of offline-tracked time
 * into 401s. But better-auth's `session.expiresIn` is a single global number,
 * so raising it took every web session from seven days to thirty as a side
 * effect, and for a while that was written down as unavoidable. It is not:
 * `databaseHooks.session.create.before` and `.update.before` both get to
 * rewrite `expiresAt`, and between them they cover the two places better-auth
 * reads the global.
 *
 * These specs pin the policy. `session-lifetime.integration.test.ts` pins that
 * better-auth actually honours it, which is the claim that matters and the one
 * that a library upgrade could break silently.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ClientKind } from "@starter/shared";
import {
  BROWSER_SESSION_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  TOKEN_CLIENT_SESSION_SECONDS,
  isTokenClient,
  sessionExpiresAt,
  sessionExpiresInSeconds,
} from "../auth/session-lifetime.js";
import {
  clientKindForNewSession,
  clientKindForSessionRefresh,
  expiryForNewSession,
  expiryForSessionRefresh,
} from "../auth/session-hooks.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const headers = (init: Record<string, string>): Headers => new Headers(init);

describe("session lifetime policy", () => {
  it("gives stored-token clients thirty days", () => {
    assert.equal(TOKEN_CLIENT_SESSION_SECONDS, 60 * 60 * 24 * 30);
    for (const client of [
      "mobile",
      "desktop",
      "raycast",
      "extension",
      "cli",
    ] satisfies ClientKind[]) {
      assert.ok(isTokenClient(client), `${client} should keep the long window`);
      assert.equal(
        sessionExpiresInSeconds(client),
        TOKEN_CLIENT_SESSION_SECONDS,
      );
    }
  });

  it("gives browsers seven days — better-auth's own default", () => {
    assert.equal(BROWSER_SESSION_SECONDS, 60 * 60 * 24 * 7);
    assert.equal(sessionExpiresInSeconds("web"), BROWSER_SESSION_SECONDS);
    assert.ok(!isTokenClient("web"));
  });

  it("treats an unlabelled client as a browser, not as a phone", () => {
    // The short window is the conservative one, so the failure mode of a
    // client that forgets to name itself is an earlier sign-in, never a
    // month-long session nobody asked for.
    assert.equal(sessionExpiresInSeconds("unknown"), BROWSER_SESSION_SECONDS);
    assert.ok(!isTokenClient("unknown"));
  });

  it("refreshes at most once a day", () => {
    assert.equal(SESSION_UPDATE_AGE_SECONDS, 60 * 60 * 24);
    assert.ok(
      SESSION_UPDATE_AGE_SECONDS < BROWSER_SESSION_SECONDS,
      "a session that refreshes less often than it expires is already expired",
    );
  });

  it("dates an expiry from a caller-supplied now", () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(
      sessionExpiresAt("web", now).getTime(),
      now + BROWSER_SESSION_SECONDS * 1000,
    );
    assert.equal(
      sessionExpiresAt("mobile", now).getTime(),
      now + TOKEN_CLIENT_SESSION_SECONDS * 1000,
    );
  });
});

describe("which client is creating a session", () => {
  it("reads the header a first-party client sets", () => {
    assert.equal(
      clientKindForNewSession({
        headers: headers({ "x-tracktime-client": "tracktime-mobile" }),
      }),
      "mobile",
    );
    assert.equal(
      clientKindForNewSession({ headers: headers({ "x-tracktime-client": "web" }) }),
      "web",
    );
  });

  it("falls back to the device flow's client_id, which sends no header", () => {
    assert.equal(
      clientKindForNewSession({ body: { client_id: "tracktime-raycast" } }),
      "raycast",
    );
  });

  it("is unknown when nothing names the client", () => {
    assert.equal(clientKindForNewSession(undefined), "unknown");
    assert.equal(clientKindForNewSession({ headers: headers({}) }), "unknown");
  });

  it("dates the new session from that client's window", () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(
      expiryForNewSession(
        { headers: headers({ "x-tracktime-client": "tracktime-mobile" }) },
        now,
      ).getTime(),
      now + TOKEN_CLIENT_SESSION_SECONDS * 1000,
    );
    assert.equal(
      expiryForNewSession(
        { headers: headers({ "x-tracktime-client": "web" }) },
        now,
      ).getTime(),
      now + BROWSER_SESSION_SECONDS * 1000,
    );
  });
});

describe("which client owns a session being refreshed", () => {
  const stamped = (client: string) => ({
    context: { session: { session: { client } } },
  });

  it("reads the client stamped on the session row, not the request", () => {
    // The WebSocket liveness re-check replays the handshake's headers, and a
    // browser handshake cannot carry a custom header at all — so a mobile
    // session's own socket would otherwise demote it to the browser window.
    assert.equal(clientKindForSessionRefresh(stamped("mobile")), "mobile");
    assert.equal(
      clientKindForSessionRefresh({ ...stamped("mobile"), headers: headers({}) }),
      "mobile",
    );
  });

  it("will not let a browser session claim the long window later", () => {
    assert.equal(
      clientKindForSessionRefresh({
        ...stamped("web"),
        headers: headers({ "x-tracktime-client": "tracktime-mobile" }),
      }),
      "web",
    );
    assert.equal(
      expiryForSessionRefresh(
        { expiresAt: new Date() },
        {
          ...stamped("web"),
          headers: headers({ "x-tracktime-client": "tracktime-mobile" }),
        },
        0,
      )?.getTime(),
      BROWSER_SESSION_SECONDS * 1000,
    );
  });

  it("falls back to the request's header when no session is on the context", () => {
    assert.equal(
      clientKindForSessionRefresh({
        headers: headers({ "x-tracktime-client": "tracktime-raycast" }),
      }),
      "raycast",
    );
    assert.equal(clientKindForSessionRefresh(undefined), "unknown");
  });

  it("leaves alone an update that is not moving the expiry", () => {
    // `updateSession` is also how the organization plugin records the active
    // workspace. Re-expiring there would turn every workspace switch into a
    // session extension.
    const workspaceSwitch = { activeOrganizationId: "w1" };
    assert.equal(expiryForSessionRefresh(workspaceSwitch, stamped("web")), null);
    assert.equal(expiryForSessionRefresh({}, stamped("mobile")), null);
  });

  it("re-aims a refresh at the owning client's window", () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(
      expiryForSessionRefresh(
        { expiresAt: new Date(now) },
        stamped("mobile"),
        now,
      )?.getTime(),
      now + TOKEN_CLIENT_SESSION_SECONDS * 1000,
    );
    assert.equal(
      expiryForSessionRefresh({ expiresAt: new Date(now) }, stamped("web"), now)
        ?.getTime(),
      now + BROWSER_SESSION_SECONDS * 1000,
    );
  });
});

describe("the wiring the policy depends on", () => {
  it("configures better-auth with the long window as the global ceiling", () => {
    const auth = read("../auth/auth.ts");
    assert.match(auth, /expiresIn: TOKEN_CLIENT_SESSION_SECONDS/);
    assert.match(auth, /updateAge: SESSION_UPDATE_AGE_SECONDS/);
    assert.doesNotMatch(
      auth,
      /expiresIn: 60 \* 60/,
      "inline the number and the reasoning stops travelling with it",
    );
  });

  it("hooks BOTH create and update, because one of them is not enough", () => {
    const auth = read("../auth/auth.ts");
    assert.match(auth, /expiresAt: expiryForNewSession\(context\)/);
    assert.match(auth, /expiryForSessionRefresh\(update, context\)/);
  });

  it("keeps the WebSocket liveness probe from renewing the session it asks about", () => {
    const wsAuth = read("../ws/auth.ts");
    assert.match(wsAuth, /disableRefresh: true/);
  });

  it("says out loud how the split is enforced and what it costs", () => {
    const module = read("../auth/session-lifetime.ts").toLowerCase();
    for (const word of ["browser", "cookie", "expiresin", "max-age", "global"]) {
      assert.ok(
        module.includes(word),
        `the rationale no longer mentions "${word}" — the argument for these ` +
          "two numbers is the whole reason they have their own file",
      );
    }
  });
});
