// The public REST API's single mount point.
//
// `registerApiV1Routes` is the ONLY symbol app.ts imports from this layer, so
// the whole surface can grow without app.ts changing again — and the middleware
// ordering it depends on is documented at the call site rather than here.
//
// The one architectural rule everything below follows: REST never enters tRPC.
// A token request authenticates here, builds a `WorkspaceScope`, and calls the
// same extracted service functions the tRPC resolvers call. There is no
// synthetic tRPC context and no token path through `workspaceProcedure`, which
// is what makes it structurally impossible for a token request to reach
// `workspaceIdFromInput` and name a workspace of its own.
import { Router, type Express, type Request, type Response } from "express";
import {
  isAuthedRequest,
  requireApiToken,
  requireScope,
  routeKey,
  type ApiHandler,
  type PublicApiHandler,
} from "./auth.js";
import {
  ApiProblemError,
  clientTooOldProblem,
  problemFromTRPCError,
  sendProblem,
} from "./problem.js";
import { versionRefusalFor } from "../../auth/client-version.js";
import { API_ROUTES, type ApiRoute } from "./routes-table.js";
import { entryHandlers } from "./routes/entries.js";
import { catalogHandlers } from "./routes/catalog.js";
import { reportHandlers } from "./routes/reports.js";
import { metaHandlers, publicMetaHandlers } from "./routes/meta.js";

export const API_V1_BASE_PATH = "/api/v1";

/** Every authenticated handler, keyed the same way {@link API_ROUTES} is. */
const HANDLERS: Readonly<Record<string, ApiHandler>> = {
  ...entryHandlers,
  ...catalogHandlers,
  ...reportHandlers,
  ...metaHandlers,
};

/** The handlers that need no credential. Only the spec document is one. */
const PUBLIC_HANDLERS: Readonly<Record<string, PublicApiHandler>> = {
  ...publicMetaHandlers,
};

/**
 * Run a handler and turn anything it throws into a problem document.
 *
 * REST answers its own errors rather than calling `next(err)`. The global
 * `errorHandler` returns `err.message` verbatim outside production, so a
 * Mongoose or driver message would become part of an API response the moment
 * somebody ran the server with NODE_ENV unset. Here a 5xx is always the same
 * fixed string and the real error goes to the log.
 */
function guard(
  handler: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (err) {
        const problem = problemFromTRPCError(err, req.originalUrl);
        if (problem.status >= 500) {
          console.error(
            JSON.stringify({
              scope: "api.v1",
              level: "error",
              event: "handler_failed",
              path: req.originalUrl,
              method: req.method,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        // A handler that already started writing (a streamed response, or a
        // second throw after `sendProblem`) cannot be given a status any more.
        if (res.headersSent) return;
        sendProblem(res, problem);
      }
    })();
  };
}

/** An authenticated handler only ever sees a request that carries a token. */
function authed(handler: ApiHandler): (req: Request, res: Response) => void {
  return guard(async (req, res) => {
    // Unreachable: `requireApiToken` runs first and answers 401 itself. It is
    // a type guard rather than a cast so that adding a field to AuthedRequest
    // cannot be papered over here — and if the chain is ever reordered, this
    // refuses with the same 401 rather than falling through to the handler.
    if (!isAuthedRequest(req)) {
      throw new ApiProblemError(
        "invalid-token",
        401,
        "Provide a valid API token as `Authorization: Bearer tt_…`.",
      );
    }
    await handler(req, res);
  });
}

function mount(router: Router, route: ApiRoute): void {
  const key = routeKey(route.method, route.path);

  if (route.isPublic) {
    const handler = PUBLIC_HANDLERS[key];
    // Throwing at startup, not 404-ing at request time: a route that is in the
    // table is a route the OpenAPI document advertises, so an unimplemented
    // one is a documented lie. Better to fail the boot than to ship it.
    if (!handler) throw new Error(`No public handler registered for "${key}"`);
    router[route.method](route.path, guard(handler));
    return;
  }

  const handler = HANDLERS[key];
  if (!handler) throw new Error(`No handler registered for "${key}"`);

  const chain = route.scope
    ? [requireApiToken, requireScope(route.scope), authed(handler)]
    : [requireApiToken, authed(handler)];
  router[route.method](route.path, ...chain);
}

export function registerApiV1Routes(app: Express): void {
  const router = Router();

  // The client API-level floor, ahead of every route and ahead of token
  // authentication: a client too old to understand the answers is told so
  // before anything else. A request that declares no level — most integrators
  // — is never refused here. The OpenAPI document stays readable.
  router.use((req: Request, res: Response, next) => {
    if (req.method === "GET" && req.path === "/openapi.json") return next();
    if (versionRefusalFor(req.headers) === null) return next();
    sendProblem(res, clientTooOldProblem(req.originalUrl));
  });

  // Mounted in table order, which is load-bearing: `/entries/current` must be
  // registered before `/entries/:id`, or Express matches the parameterised
  // route first and "current" is looked up as an entry id — a 404 for a timer
  // that is running.
  for (const route of API_ROUTES) mount(router, route);

  // A 404 inside /api/v1 answers problem+json like everything else here. Left
  // to the global handler it would come back as the app's own JSON shape, and
  // a client that parses one error format would fail to parse the other.
  router.use((req: Request, res: Response) => {
    sendProblem(res, {
      type: "https://trackyourtime.dev/problems/no-such-route",
      title: "Not Found",
      status: 404,
      detail: `No API route matches ${req.method} ${req.originalUrl}. See ${API_V1_BASE_PATH}/openapi.json.`,
      instance: req.originalUrl,
    });
  });

  app.use(API_V1_BASE_PATH, router);
}
