// The OpenAPI 3.1 document, generated from the route table.
//
// Generated and never hand-written. A hand-written spec beside hand-written
// wiring drifts inside one release: somebody adds a route and forgets the
// spec, or renames a field and forgets both. Here the same array that mounts
// the routes describes them, and the field-level shapes come from the very
// zod schemas that validate and serialize — `z.toJSONSchema` is native in
// zod 4, so there is no second schema library to keep in step either.
import { z } from "zod";
import { API_ROUTES, type ApiRoute } from "./routes-table.js";
import { PROBLEM_BASE } from "./problem.js";

/** Everything under `/api/v1`. Baked in so the document is self-describing. */
const BASE_PATH = "/api/v1";

type JsonObject = Record<string, unknown>;

/**
 * A JSON Schema for embedding inside the document.
 *
 * `$schema` is stripped: it is meaningful at the root of a standalone schema
 * document and noise (occasionally an error) inside an OpenAPI `schema` slot.
 */
function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
  }) as JsonObject;
  const { $schema: _ignored, ...rest } = json;
  return rest;
}

/** `:id` → `{id}`, which is what OpenAPI templates look like. */
function templatedPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/** The `:name` segments of an Express path, in order. */
function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? "");
}

/**
 * `getEntriesById`-ish. Stable across releases because it is derived from the
 * method and path, which are the two things a client generator names its
 * functions after — regenerating a client must not rename every call site.
 */
function operationId(route: ApiRoute): string {
  const parts = route.path
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(":")
        ? `By${segment.slice(1, 2).toUpperCase()}${segment.slice(2)}`
        : segment.slice(0, 1).toUpperCase() + segment.slice(1),
    );
  return route.method + parts.join("").replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Split an object schema into one OpenAPI parameter per property.
 *
 * Query parameters are documented individually rather than as one object
 * because that is what tooling renders as a form and what a generator turns
 * into named function arguments.
 */
function queryParameters(schema: z.ZodType): JsonObject[] {
  const json = jsonSchemaOf(schema, "input");
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((json.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, value]) => ({
    name,
    in: "query",
    required: required.has(name),
    // Repeated keys and one comma-separated key both work; `form`/`explode:
    // true` is the repeated-key spelling, which is the one generators emit.
    ...(value.type === "array" ? { style: "form", explode: true } : {}),
    schema: value,
  }));
}

function pathParameters(path: string): JsonObject[] {
  return pathParamNames(path).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1 },
  }));
}

/**
 * The request body, with any path parameter removed from it.
 *
 * The shared update schemas carry the resource `id` because tRPC has no path
 * to put it in, and zod will not let a refined object have a field omitted
 * (`updateEntrySchema` enforces "end after start"). The handler merges the
 * path id in over the body, so documenting `id` as a body field would tell a
 * generated client to send something that is always ignored — and mark it
 * required, which would make a correct request look invalid.
 */
function requestBody(route: ApiRoute): JsonObject | null {
  if (!route.input || route.input.source !== "body") return null;
  const json = jsonSchemaOf(route.input.schema, "input");
  const owned = new Set(pathParamNames(route.path));

  const properties = { ...((json.properties ?? {}) as Record<string, unknown>) };
  for (const name of owned) delete properties[name];
  const required = ((json.required as string[] | undefined) ?? []).filter(
    (name) => !owned.has(name),
  );

  const schema: JsonObject = { ...json, properties };
  if (required.length > 0) schema.required = required;
  else delete schema.required;

  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

/** The problem+json body, referenced by every error response. */
const PROBLEM_SCHEMA: JsonObject = {
  type: "object",
  description:
    "RFC 9457 problem detail. `type` dereferences to documentation for the failure.",
  properties: {
    type: { type: "string", format: "uri", examples: [`${PROBLEM_BASE}insufficient-scope`] },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
  },
  required: ["type", "title", "status", "detail", "instance"],
};

const problemResponse = (description: string, headers?: JsonObject): JsonObject => ({
  description,
  ...(headers ? { headers } : {}),
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
});

/**
 * The budget headers, documented on every response an authenticated route can
 * give — the success as much as the 429.
 *
 * A client that can only learn its budget by being refused has to hit the wall
 * to find out where it is, so the headers ride along on the 200 too; saying so
 * only on the 429 would document a backoff strategy nobody can implement
 * before their first failure.
 */
const RATE_LIMIT_HEADERS: JsonObject = {
  "RateLimit-Limit": {
    // Two counters are charged per request — the token's and the workspace's —
    // and these headers report whichever is closer to refusing. Describing the
    // limit as "this token's" would have a client size its backoff against a
    // budget it is not actually bounded by whenever a sibling token is the
    // reason the next request gets a 429.
    description:
      "Requests allowed per 60-second window by the binding budget — this token's, or the workspace's when that is the tighter of the two.",
    schema: { type: "integer" },
  },
  "RateLimit-Remaining": {
    description: "Requests left in the current window, under the same budget as `RateLimit-Limit`.",
    schema: { type: "integer" },
  },
  "RateLimit-Reset": {
    description: "Seconds until the current window rolls over.",
    schema: { type: "integer" },
  },
};

const RETRY_AFTER_HEADERS: JsonObject = {
  ...RATE_LIMIT_HEADERS,
  "Retry-After": {
    description: "Seconds to wait before retrying. Sent only on 429.",
    schema: { type: "integer" },
  },
};

/**
 * The error responses every authenticated route can answer with.
 *
 * Listed on every operation rather than described once in prose, because a
 * generated client only handles the statuses its spec mentions — an
 * undocumented 429 becomes an unhandled exception in somebody's integration.
 */
function errorResponses(route: ApiRoute): JsonObject {
  if (route.isPublic) return {};
  const responses: JsonObject = {
    "400": problemResponse("The request could not be validated."),
    "401": problemResponse("Missing, malformed, revoked, expired or unknown token."),
    "429": problemResponse("Rate limit exceeded. See `Retry-After`.", RETRY_AFTER_HEADERS),
    "500": problemResponse("Unexpected server error."),
  };
  if (route.scope !== null) {
    responses["403"] = problemResponse(
      "The token does not carry the required scope, or may not see the money in this response.",
    );
  }
  if (pathParamNames(route.path).length > 0) {
    // Also the answer for a resource in another workspace: a foreign id reads
    // as missing, never as forbidden, so nothing here confirms it exists.
    responses["404"] = problemResponse("No such resource in this token's workspace.");
  }
  return responses;
}

function operationOf(route: ApiRoute): JsonObject {
  const parameters = [
    ...pathParameters(route.path),
    ...(route.input?.source === "query" ? queryParameters(route.input.schema) : []),
  ];

  const body = requestBody(route);

  return {
    operationId: operationId(route),
    summary: route.summary,
    tags: [tagOf(route)],
    ...(route.scope ? { "x-required-scope": route.scope } : {}),
    // `security: []` is how OpenAPI spells "this one needs no credential" in a
    // document that otherwise requires one globally.
    ...(route.isPublic ? { security: [] } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses: {
      "200": {
        description: "Success.",
        ...(route.isPublic ? {} : { headers: RATE_LIMIT_HEADERS }),
        content: {
          "application/json": {
            schema: route.output
              ? jsonSchemaOf(route.output, "output")
              : { type: "object" },
          },
        },
      },
      ...errorResponses(route),
    },
  };
}

/** First path segment, so tooling groups the operations the way people think. */
function tagOf(route: ApiRoute): string {
  const first = route.path.split("/").filter(Boolean)[0] ?? "meta";
  if (first === "me" || first === "openapi.json") return "meta";
  return first;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, JsonObject> = {};
  for (const route of API_ROUTES) {
    const key = `${BASE_PATH}${templatedPath(route.path)}`;
    const existing = paths[key] ?? {};
    existing[route.method] = operationOf(route);
    paths[key] = existing;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Track Your Time API",
      version: "1.0.0",
      description:
        "Read and write tracked time, the catalog behind it, and reports over both.\n\n" +
        "Authenticate with an API token as `Authorization: Bearer tt_…`. A token is bound to one " +
        "workspace and carries the visibility its creating member had when it was minted, " +
        "intersected with that member's visibility right now — it can never show more than its " +
        "owner may see.",
    },
    servers: [{ url: "https://api.trackyourtime.dev" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An API token from Settings → API. Format: `tt_<prefix>_<secret>`.",
        },
      },
      schemas: { Problem: PROBLEM_SCHEMA },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
