// Errors on the REST surface: what the caller is told, and what they are not.
//
// Two failure modes this pins down, both silent:
//  - a 5xx that carries the thrown message. The global `errorHandler` returns
//    `err.message` verbatim outside production, so a REST handler that threw
//    into it would disclose driver text to anyone running the server with
//    NODE_ENV unset. Every 5xx here must be the one fixed string.
//  - a scope check that passes on an empty array. Deny-by-default has to be a
//    property of the guard; a token with no scopes must be able to do nothing.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ApiTokenScope } from "@starter/shared/api-tokens";
import { API_TOKEN_SCOPES } from "@starter/shared/api-tokens";
import {
  ApiProblemError,
  INTERNAL_DETAIL,
  moneyVisibilityProblem,
  notFoundProblem,
  problemFromTRPCError,
  sendProblem,
} from "../api/v1/problem.js";
import { requireScope, type AuthedRequest } from "../api/v1/auth.js";

/** Records what a handler wrote, without an HTTP server in the way. */
type Recorded = {
  status: number;
  contentType: string;
  body: string;
  json: unknown;
  headers: Record<string, string>;
};

function fakeResponse(): { res: Response; recorded: Recorded } {
  const recorded: Recorded = {
    status: 0,
    contentType: "",
    body: "",
    json: undefined,
    headers: {},
  };
  const res = {
    status(code: number) {
      recorded.status = code;
      return this;
    },
    type(value: string) {
      recorded.contentType = value;
      return this;
    },
    send(value: string) {
      recorded.body = value;
      return this;
    },
    json(value: unknown) {
      recorded.json = value;
      return this;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
    },
  } as unknown as Response;
  return { res, recorded };
}

const INSTANCE = "/api/v1/entries/65f1c2d3e4f5a6b7c8d9e0f1";

describe("problemFromTRPCError", () => {
  it("maps every code the services actually throw", () => {
    const cases: [TRPCError["code"], number][] = [
      ["BAD_REQUEST", 400],
      ["UNAUTHORIZED", 401],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["PAYLOAD_TOO_LARGE", 413],
      ["TOO_MANY_REQUESTS", 429],
    ];
    for (const [code, status] of cases) {
      const problem = problemFromTRPCError(
        new TRPCError({ code, message: "a message about the request" }),
        INSTANCE,
      );
      assert.equal(problem.status, status, code);
      assert.equal(problem.detail, "a message about the request", code);
      assert.equal(problem.instance, INSTANCE);
      assert.match(problem.type, /^https:\/\/trackyourtime\.dev\/problems\//);
    }
  });

  it("never lets a 5xx carry the thrown message", () => {
    // The one that matters: an INTERNAL_SERVER_ERROR whose message names a
    // collection, a query or a value must come back as the fixed string.
    const leaky = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: 'E11000 duplicate key on timeentries index authorId_1 dup key: { authorId: "u_42" }',
    });
    const problem = problemFromTRPCError(leaky, INSTANCE);
    assert.equal(problem.status, 500);
    assert.equal(problem.detail, INTERNAL_DETAIL);
    assert.ok(!problem.detail.includes("u_42"));
    assert.ok(!problem.detail.includes("timeentries"));
  });

  it("gives an unmapped tRPC code a 500, not a guessed 400", () => {
    const problem = problemFromTRPCError(
      new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: "who knows" }),
      INSTANCE,
    );
    assert.equal(problem.status, 500);
    assert.equal(problem.detail, INTERNAL_DETAIL);
  });

  it("turns an ordinary throw into a 500 that discloses nothing", () => {
    const problem = problemFromTRPCError(new Error("connect ECONNREFUSED 10.0.0.7:27017"), INSTANCE);
    assert.equal(problem.status, 500);
    assert.equal(problem.detail, INTERNAL_DETAIL);
    assert.ok(!problem.detail.includes("10.0.0.7"));
  });

  it("reports a validation failure in full, naming the fields", () => {
    const schema = z.object({ start: z.iso.datetime(), limit: z.number() });
    const parsed = schema.safeParse({ start: "not-a-date", limit: "ten" });
    assert.equal(parsed.success, false);
    const problem = problemFromTRPCError(parsed.error, INSTANCE);
    assert.equal(problem.status, 400);
    assert.match(problem.detail, /start/);
    assert.match(problem.detail, /limit/);
  });

  it("keeps a route's own slug instead of flattening it to the status", () => {
    // Without this, "wrong scope" and "may not see money" would both arrive as
    // `problems/forbidden` and a client could only tell them apart by prose.
    const problem = problemFromTRPCError(moneyVisibilityProblem(), INSTANCE);
    assert.equal(problem.status, 403);
    assert.equal(problem.type, "https://trackyourtime.dev/problems/money-visibility-required");
  });

  it("still hides the message when a route names a 5xx slug", () => {
    const problem = problemFromTRPCError(
      new ApiProblemError("storage-unavailable", 500, "bucket trackyourtime-prod is unreachable"),
      INSTANCE,
    );
    assert.equal(problem.detail, INTERNAL_DETAIL);
  });

  it("answers a hidden or foreign resource with 404, never 403", () => {
    // A 403 on a foreign id confirms the id exists somewhere, which turns the
    // endpoint into an enumeration oracle.
    const problem = problemFromTRPCError(notFoundProblem("Entry not found"), INSTANCE);
    assert.equal(problem.status, 404);
    assert.equal(problem.type, "https://trackyourtime.dev/problems/not-found");
  });
});

describe("sendProblem", () => {
  it("writes RFC 9457 fields under the problem media type", () => {
    const { res, recorded } = fakeResponse();
    sendProblem(res, problemFromTRPCError(notFoundProblem("Tag not found"), INSTANCE));
    assert.equal(recorded.status, 404);
    // Not `application/json`: a client that content-negotiates errors keys on
    // this, and so do the browser devtools that render it.
    assert.equal(recorded.contentType, "application/problem+json");
    const body = JSON.parse(recorded.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "detail",
      "instance",
      "status",
      "title",
      "type",
    ]);
    assert.equal(body.instance, INSTANCE);
  });
});

// ── scope enforcement ────────────────────────────────────────────────

function authedRequest(scopes: ApiTokenScope[]): Request {
  return {
    originalUrl: INSTANCE,
    apiQuery: {},
    apiToken: {
      tokenId: "t_1",
      workspaceId: "w_1",
      userId: "u_1",
      scopes,
      visibility: { userId: "u_1", canViewOthersTime: false, canViewOthersMoney: false },
      membership: {},
    },
  } as unknown as AuthedRequest;
}

describe("requireScope", () => {
  it("grants nothing to a token with an empty scope array", () => {
    // The closed position: a zero-scope token is legal and useless. A
    // `scopes ?? ALL` default anywhere would invert this for every row written
    // before the field existed.
    for (const scope of API_TOKEN_SCOPES) {
      const { res, recorded } = fakeResponse();
      let reached = false;
      requireScope(scope)(authedRequest([]), res, () => {
        reached = true;
      });
      assert.equal(reached, false, scope);
      assert.equal(recorded.status, 403, scope);
      assert.equal(
        JSON.parse(recorded.body).type,
        "https://trackyourtime.dev/problems/insufficient-scope",
      );
    }
  });

  it("gates each scope on exactly itself", () => {
    for (const held of API_TOKEN_SCOPES) {
      for (const required of API_TOKEN_SCOPES) {
        const { res } = fakeResponse();
        let reached = false;
        requireScope(required)(authedRequest([held]), res, () => {
          reached = true;
        });
        assert.equal(reached, held === required, `${held} -> ${required}`);
      }
    }
  });

  it("does not let entries:write imply entries:read", () => {
    // An implication is the kind of rule a reviewer stops re-checking. A route
    // that requires read requires read.
    const { res, recorded } = fakeResponse();
    let reached = false;
    requireScope("entries:read")(authedRequest(["entries:write"]), res, () => {
      reached = true;
    });
    assert.equal(reached, false);
    assert.equal(recorded.status, 403);
  });

  it("refuses a request that never authenticated, with 401 not 403", () => {
    // Reached only if the middleware chain is ever reordered. It must not fall
    // through to the handler, and it must not claim a scope problem.
    const { res, recorded } = fakeResponse();
    let reached = false;
    requireScope("entries:read")(
      { originalUrl: INSTANCE } as unknown as Request,
      res,
      () => {
        reached = true;
      },
    );
    assert.equal(reached, false);
    assert.equal(recorded.status, 401);
  });
});
