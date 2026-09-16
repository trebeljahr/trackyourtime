// Errors, as RFC 9457 `application/problem+json`.
//
// The REST surface answers its OWN errors rather than throwing into the global
// `errorHandler`. That is not tidiness: outside production the global handler
// returns `err.message` verbatim, so a stack-adjacent message from Mongoose or
// a driver would become part of an API response the moment somebody ran the
// server with NODE_ENV unset. Here a 5xx `detail` is the same fixed string in
// every environment, and the real error goes to the log instead.
import { TRPCError } from "@trpc/server";
import type { Response } from "express";
import { ZodError } from "zod";
import { CLIENT_TOO_OLD_MESSAGE } from "../../auth/client-version.js";

/**
 * Problem `type` URIs are documentation URLs, not endpoints — a client that
 * dereferences one gets prose about the failure, which is exactly what the
 * spec intends. Keeping the base here means the slug is the only thing a
 * call site has to know.
 */
const PROBLEM_BASE = "https://trackyourtime.dev/problems/";

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

/**
 * What a 5xx tells the caller. Always this, never the thrown message.
 *
 * A generic string is the point: an unexpected error is by definition one
 * nobody has vetted the wording of, and a database driver's message routinely
 * carries collection names, query shapes and occasionally values.
 */
const INTERNAL_DETAIL = "The server could not complete this request.";

/** Slug + human title per status, so two call sites cannot word one error twice. */
const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  412: "Precondition Failed",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/**
 * tRPC error codes to HTTP.
 *
 * Only the codes the extracted services actually throw are listed. Anything
 * else falls through to 500 deliberately — a code nobody mapped is a code
 * nobody decided the disclosure rules for, and guessing 400 would leak the
 * distinction between "you asked wrong" and "we broke".
 */
const STATUS_BY_TRPC_CODE: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
};

/** Default slug for a status, used when the caller has no better name. */
const SLUG_BY_STATUS: Readonly<Record<number, string>> = {
  400: "invalid-request",
  401: "invalid-token",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  413: "payload-too-large",
  429: "rate-limited",
  500: "internal-error",
};

/**
 * A refusal this layer raises itself, carrying its own problem `type` slug.
 *
 * The services throw `TRPCError`s, whose codes only name a STATUS — every
 * FORBIDDEN would otherwise become `problems/forbidden`, and a client could
 * not tell "wrong scope" from "may not see money" without parsing prose. This
 * class is how a route names its own slug without a second error taxonomy:
 * `problemFromTRPCError` checks for it first and maps everything else exactly
 * as before.
 */
export class ApiProblemError extends Error {
  readonly slug: string;
  readonly status: number;

  constructor(slug: string, status: number, detail: string) {
    super(detail);
    this.name = "ApiProblemError";
    this.slug = slug;
    this.status = status;
  }
}

/** Build a problem from a status and a slug of your choosing. */
export function problem(args: {
  slug: string;
  status: number;
  detail: string;
  instance: string;
}): Problem {
  return {
    type: `${PROBLEM_BASE}${args.slug}`,
    title: TITLES[args.status] ?? "Error",
    status: args.status,
    detail: args.detail,
    instance: args.instance,
  };
}

/** Write a problem. Sets the media type RFC 9457 requires, not `application/json`. */
export function sendProblem(res: Response, value: Problem): void {
  res.status(value.status).type("application/problem+json").send(JSON.stringify(value));
}

/** One-liner for the common "known refusal" case. */
export function sendProblemFor(
  res: Response,
  args: { slug: string; status: number; detail: string; instance: string },
): void {
  sendProblem(res, problem(args));
}

/**
 * Map anything a service threw onto a problem.
 *
 * Zod first, because a validation failure is the one error whose message is
 * safe to hand back in full — it describes the caller's own input and nothing
 * about the server. Everything unrecognised becomes a 500 with the fixed
 * detail, whatever it claims about itself.
 */
export function problemFromTRPCError(err: unknown, instance: string): Problem {
  if (err instanceof ApiProblemError) {
    return problem({
      slug: err.slug,
      status: err.status,
      detail: err.status >= 500 ? INTERNAL_DETAIL : err.message,
      instance,
    });
  }

  if (err instanceof ZodError) {
    return problem({
      slug: "invalid-request",
      status: 400,
      detail: formatZodError(err),
      instance,
    });
  }

  if (err instanceof TRPCError) {
    const status = STATUS_BY_TRPC_CODE[err.code] ?? 500;
    return problem({
      slug: SLUG_BY_STATUS[status] ?? "internal-error",
      status,
      // A 5xx never carries the thrown message, in any environment.
      detail: status >= 500 ? INTERNAL_DETAIL : err.message,
      instance,
    });
  }

  return problem({
    slug: "internal-error",
    status: 500,
    detail: INTERNAL_DETAIL,
    instance,
  });
}

/** Compact, one line per rejected field: `start: Invalid ISO datetime`. */
export function formatZodError(err: ZodError): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return lines.length > 0 ? lines.join("; ") : "Invalid request.";
}

export { INTERNAL_DETAIL, PROBLEM_BASE };

/**
 * A resource this token's workspace does not own, or one its visibility hides.
 *
 * Always NOT_FOUND, never FORBIDDEN. A 403 on a foreign id confirms the id
 * exists somewhere, which turns the endpoint into an enumeration oracle. 403
 * is reserved for a scope refusal or a money refusal on a resource this
 * workspace genuinely owns.
 *
 * A `TRPCError` rather than a second error class, so the one mapping function
 * above covers both this and anything the shared services throw — there is no
 * parallel taxonomy to keep in step.
 */
export function notFoundProblem(message: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message });
}

/**
 * A response the caller may not be shown the money in.
 *
 * Raised by the report routes and by `GET /entries`, which serves rows
 * carrying the same `amount` — so the wording names neither surface. A detail
 * string that says "report" while answering an entry list sends the reader
 * looking for a report they never asked for.
 *
 * 403 rather than a stripped 200, because there is no honest stripped version
 * of a total: zeroing it produces a page of numbers a spreadsheet will sum,
 * and omitting it produces a report whose own totals do not reconcile. Refusing
 * says what happened; both alternatives lie quietly.
 *
 * 403 and not 404 because the workspace genuinely owns this data — the caller
 * is being told about a permission, not about whether something exists.
 */
export function moneyVisibilityProblem(): ApiProblemError {
  return new ApiProblemError(
    "money-visibility-required",
    403,
    "This response would span other members' time, and this token may not see what it is worth. Grant `canViewOthersMoney` to the member who owns it and mint a new token.",
  );
}

/**
 * The request declared an API level below this server's floor
 * (`x-trackyourtime-api-level` < `MIN_CLIENT_API_LEVEL`).
 *
 * 412 with its own slug, the REST twin of tRPC's `data.versionRefusal:
 * "CLIENT_TOO_OLD"`. Not 400: a client that retries queued work treats 400 as
 * "never send this again", and version skew must never delete anybody's data.
 */
export function clientTooOldProblem(instance: string): Problem {
  return problem({
    slug: "client-too-old",
    status: 412,
    detail: CLIENT_TOO_OLD_MESSAGE,
    instance,
  });
}
