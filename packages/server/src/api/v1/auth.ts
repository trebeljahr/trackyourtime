import { assertStandardWorkspace } from "../../services/privacy/access.js";
// Who is calling, and what they are allowed to ask for.
//
// This is the whole boundary between an HTTP request and a `WorkspaceScope`.
// Nothing below it takes a workspace id from the caller — the workspace comes
// off the token, and a token is bound to exactly one. That is what makes the
// "a token can never address a workspace of its own choosing" rule structural
// rather than a thing every handler has to remember.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiTokenScope } from "@starter/shared";
import {
  authenticateApiToken,
  hasScope,
  isApiTokenAuth,
  parseApiToken,
  type ApiTokenAuth,
} from "../../auth/api-token.js";
import { sendProblemFor } from "./problem.js";
import {
  checkAuthFailureBudget,
  consumeRateLimit,
  recordAuthFailure,
  setRateLimitHeaders,
  type RateLimitResult,
} from "./rate-limit.js";

/**
 * A request that has passed {@link requireApiToken}.
 *
 * `apiQuery` exists because Express 5 defines `req.query` as a GETTER that
 * re-parses the URL on every access — deleting a key off the object it returns
 * is undone by the next read. So the sanitised copy is taken once, here, and
 * handlers read that. (The real guarantee is still further down: the zod
 * schemas strip unknown keys and no service accepts a workspace id from input.
 * This is the outermost of three layers, not the only one.)
 */
export type AuthedRequest = Request & {
  apiToken: ApiTokenAuth;
  apiQuery: Record<string, unknown>;
};

/** Narrowing helper, so no handler has to cast. */
export function isAuthedRequest(req: Request): req is AuthedRequest {
  return "apiToken" in req && "apiQuery" in req;
}

/**
 * The single 401 body.
 *
 * Every {@link ApiTokenFailure} variant lands here with the same wording.
 * Telling "no such token" apart from "wrong secret", or "expired" apart from
 * "revoked", turns the endpoint into an oracle that confirms which prefixes
 * exist — the distinctions are for the server log, never for the caller.
 */
function unauthorized(res: Response, instance: string): void {
  sendProblemFor(res, {
    slug: "invalid-token",
    status: 401,
    detail:
      "Provide a valid API token as `Authorization: Bearer tt_…`. Tokens are managed in Settings → API.",
    instance,
  });
}

/**
 * The client address half of a failure key.
 *
 * `req.ip` rather than the raw socket or a hand-read `X-Forwarded-For`,
 * because the app sets `trust proxy` — Express has already resolved which hop
 * to believe, and reading the header directly would either trust one the proxy
 * config says not to (so any caller picks their own key and the meter is
 * decorative) or ignore the proxy entirely (so every request in production
 * shares the load balancer's address). What Express resolves is only correct
 * when the hop count matches the deployment, which is why it is
 * `TRUST_PROXY_HOPS` rather than a hardcoded 1 — see `docs/deploy.md`. The
 * fallback exists only for a socket with no address at all, which is a
 * unit-test transport rather than a real request.
 */
function clientAddress(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * What a failed authentication is charged to: the source address AND the token
 * prefix that was presented.
 *
 * Keyed on the address ALONE this meter refused valid credentials. Thirty
 * rejected requests — one customer's revoked token, retried by its cron —
 * burned the budget for every other integration sharing that egress address:
 * the office NAT, the shared CI runner, the PaaS egress pool. It was also
 * weaponisable on purpose, by anyone who knew a victim shared an address and
 * was willing to send thirty bogus `Bearer` values a minute.
 *
 * Including the prefix makes the key name the credential that actually failed,
 * so the request being gated and the requests that filled the budget are the
 * same credential. A valid token's key can only be burned by presenting that
 * same prefix with a bad secret, which needs the prefix — and a caller holding
 * the prefix and failing on the secret is exactly who this should ration.
 *
 * An unparseable or absent token falls back to the bare address, on purpose:
 * those cost no database lookup, and they must not share a key with any real
 * credential from the same address or the denial primitive comes straight
 * back.
 */
export function authFailureKey(
  address: string,
  authorizationHeader: string | undefined,
): string {
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? "");
  const presented = match?.[1] ? parseApiToken(match[1]) : null;
  return presented === null ? address : `${address}:${presented.prefix}`;
}

function sendRateLimited(
  res: Response,
  result: RateLimitResult,
  instance: string,
): void {
  res.setHeader("Retry-After", String(result.resetSeconds));
  sendProblemFor(res, {
    slug: "rate-limited",
    status: 429,
    detail: `Rate limit of ${result.limit} requests per minute exceeded. Retry in ${result.resetSeconds}s.`,
    instance,
  });
}

/**
 * Meter, authenticate, rate-limit, and sanitise — in that order, which is
 * forced.
 *
 * Rate limiting is inside this middleware rather than beside it because the
 * authenticated counter is keyed on the token and the workspace: there is no
 * honest way to count a request that way before knowing whose it is, and a
 * separate middleware could be mounted in the wrong order without anything
 * failing loudly.
 *
 * The FAILED path is metered first and read before the token lookup —
 * otherwise every rejected request still buys an indexed `ApiToken.findOne`,
 * at whatever rate the caller likes, with no credential required to ask. That
 * gate is keyed per CREDENTIAL, not per address ({@link authFailureKey}), so a
 * request presenting a valid token is never refused by failures that some
 * other caller behind the same address accumulated.
 */
export const requireApiToken: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  void (async () => {
    const instance = req.originalUrl;
    const failureKey = authFailureKey(
      clientAddress(req),
      req.headers.authorization,
    );

    const failureBudget = await checkAuthFailureBudget(failureKey);
    if (!failureBudget.allowed) {
      sendRateLimited(res, failureBudget, instance);
      return;
    }

    const auth = await authenticateApiToken(req.headers.authorization);
    if (!isApiTokenAuth(auth)) {
      // Charged only on failure, and only to the credential that failed. A
      // client presenting a valid token accumulates nothing, and — because the
      // key carries the presented prefix — never inherits a budget some other
      // credential from the same address burned.
      await recordAuthFailure(failureKey);
      unauthorized(res, instance);
      return;
    }

    await assertStandardWorkspace(auth.workspaceId);

    const limit = await consumeRateLimit({
      tokenId: auth.tokenId,
      workspaceId: auth.workspaceId,
    });
    setRateLimitHeaders(res, limit);
    if (!limit.allowed) {
      sendRateLimited(res, limit, instance);
      return;
    }

    // Belt and braces on top of the schemas' unknown-key stripping: if a
    // caller went to the trouble of naming a workspace, refuse rather than
    // silently serving a different one than they asked about. Same-workspace
    // is tolerated so a client that mirrors its tRPC payloads still works.
    const bodyWorkspace = workspaceIdIn(req.body);
    const queryWorkspace = workspaceIdIn(req.query);
    for (const named of [bodyWorkspace, queryWorkspace]) {
      if (named !== null && named !== auth.workspaceId) {
        sendProblemFor(res, {
          slug: "workspace-not-addressable",
          status: 400,
          detail:
            "An API token is bound to one workspace and cannot address another. Remove `workspaceId` from the request.",
          instance,
        });
        return;
      }
    }

    const apiQuery: Record<string, unknown> = { ...req.query };
    delete apiQuery.workspaceId;
    if (req.body !== null && typeof req.body === "object") {
      delete (req.body as Record<string, unknown>).workspaceId;
    }

    const authed = req as AuthedRequest;
    authed.apiToken = auth;
    authed.apiQuery = apiQuery;
    next();
  })().catch(next);
};

/** `workspaceId` off an untrusted payload, or null when it was not a string. */
function workspaceIdIn(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const named = (value as Record<string, unknown>).workspaceId;
  return typeof named === "string" ? named : null;
}

/**
 * Gate a route on one scope.
 *
 * Delegates to {@link hasScope} rather than re-spelling `.includes`, because
 * deny-by-default is pinned by a test over that function: a token whose
 * `scopes` array is empty must pass nothing, and a `?? ALL_SCOPES` default
 * anywhere would invert that for every row written before the field existed.
 */
export function requireScope(scope: ApiTokenScope): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAuthedRequest(req)) {
      unauthorized(res, req.originalUrl);
      return;
    }
    if (!hasScope(req.apiToken.scopes, scope)) {
      sendProblemFor(res, {
        slug: "insufficient-scope",
        status: 403,
        detail: `This token does not carry the \`${scope}\` scope.`,
        instance: req.originalUrl,
      });
      return;
    }
    next();
  };
}

/** What every route module exports: one async function per table entry. */
export type ApiHandler = (
  req: AuthedRequest,
  res: Response,
) => Promise<void> | void;

/**
 * A route callable with no token — only the spec document is.
 *
 * A separate type, not a widened {@link ApiHandler}: giving public handlers a
 * request that merely happens to lack `apiToken` at runtime is how one grows a
 * read of it and starts throwing on every anonymous call.
 */
export type PublicApiHandler = (
  req: Request,
  res: Response,
) => Promise<void> | void;

/** Handlers keyed by `"<method> <path>"`, matching {@link ApiRoute}. */
export type ApiHandlers = Readonly<Record<string, ApiHandler>>;
export type PublicApiHandlers = Readonly<Record<string, PublicApiHandler>>;

/** The key both the table and the handler maps agree on. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}
