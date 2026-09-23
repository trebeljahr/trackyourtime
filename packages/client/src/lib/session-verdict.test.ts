import { describe, expect, it } from "vitest";

import {
  verdictForRejection,
  verdictForResult,
} from "@/lib/session-verdict";

const web = { hasStoredToken: false };
const phone = { hasStoredToken: true };
/** A web browser whose session hook has already resolved a session. */
const webSignedIn = { hasStoredToken: false, hasSession: true };

describe("verdictForResult", () => {
  it("signs a user in when the server returns a session", () => {
    expect(verdictForResult({ data: { session: { id: "s1" } } }, web)).toBe("in");
    expect(verdictForResult({ data: { session: { id: "s1" } } }, phone)).toBe(
      "in",
    );
  });

  it("signs a user out when the server cleanly says there is no session", () => {
    // `{ data: null, error: null }` is the only honest sign-out: the server
    // was reached and it answered.
    expect(verdictForResult({ data: null, error: null }, web)).toBe("out");
    expect(verdictForResult({ data: null, error: null }, phone)).toBe("out");
  });

  it("keeps a stored session through an HTTP-level failure", () => {
    // @better-fetch/fetch resolves rather than rejects on an error response,
    // so a 502 mid-redeploy arrives here and not in the .catch(). Without
    // this branch a proxy hiccup signs a phone out and unmounts its running
    // timer.
    const proxyError = { data: null, error: { status: 502 } };

    expect(verdictForResult(proxyError, phone)).toBe("in");
    expect(verdictForResult(proxyError, web)).toBe("out");
    // The protected layout confirms even a session it already holds, so the
    // same rule has to cover the browser: a 502 must not evict a signed-in
    // web user who was rendering the app a moment ago.
    expect(verdictForResult(proxyError, webSignedIn)).toBe("in");
  });

  it("signs a held session out when the server cleanly says it is gone", () => {
    // The account was deleted elsewhere. A session in hand is evidence, never
    // proof — better-auth serves one out of a five-minute cookie cache — so a
    // clean null from a cache-bypassing check outranks it.
    expect(verdictForResult({ data: null, error: null }, webSignedIn)).toBe(
      "out",
    );
  });

  it("treats a missing result as no answer", () => {
    expect(verdictForResult(undefined, web)).toBe("out");
    expect(verdictForResult(null, phone)).toBe("out");
  });
});

describe("verdictForRejection", () => {
  it("keeps a stored session when the transport failed outright", () => {
    // Cold launch on the underground. The token is the evidence that this
    // device signed in; a dead radio is not evidence that it signed out.
    expect(verdictForRejection(phone)).toBe("in");
  });

  it("keeps a browser in when it holds a session and the request failed", () => {
    expect(verdictForRejection(webSignedIn)).toBe("in");
  });

  it("still sends a tokenless client with no session to /login", () => {
    expect(verdictForRejection(web)).toBe("out");
  });
});
