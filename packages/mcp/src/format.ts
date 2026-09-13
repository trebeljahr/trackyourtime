// Turning API answers and failures into text a model can relay.
//
// A tool result is read by a model and then, usually, paraphrased to a person.
// So an error names what happened, the server's own words, and the one thing
// to change — the model should never have to guess whether "403" meant a
// wrong token, a missing scope or money it may not see.

import { formatDurationShort } from "@starter/shared/duration";
import { addDaysToKey, isValidTimeZone, zonedDayStartMs } from "@starter/shared/timezone";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiProblem, ApiUnexpectedResponse, ApiUnreachable } from "./api-client.js";

const SETTINGS_PATH = "Settings → Integrations → API tokens";

function slugOf(problemType: string | undefined): string | null {
  if (!problemType) return null;
  const slug = problemType.split("/").filter(Boolean).pop();
  return slug ?? null;
}

/** The one actionable sentence per known refusal. */
function hintFor(error: ApiProblem): string | null {
  const slug = slugOf(error.problem?.type);
  switch (slug) {
    case "invalid-token":
      return `Check TRACKYOURTIME_API_TOKEN. A token works only on the server that minted it, so also check TRACKYOURTIME_API_URL. Mint a new token in ${SETTINGS_PATH} if this one was revoked or expired.`;
    case "insufficient-scope":
      return `Mint a token that includes this scope in ${SETTINGS_PATH} and restart the MCP server with it. Scopes cannot be added to an existing token.`;
    case "rate-limited":
      return error.retryAfterSec !== null
        ? `Wait ${error.retryAfterSec} seconds before calling again.`
        : "Wait a minute before calling again.";
    case "money-visibility-required":
      return "This workspace does not let the token's owner see other members' money, so reports are refused. The workspace owner can change that in the web app.";
    case "workspace-not-addressable":
      return "A token is bound to one workspace. Mint a token inside the workspace you want to reach.";
    default:
      break;
  }
  if (error.status === 404) {
    return "The id does not exist in this token's workspace. List the resource first to get a current id.";
  }
  if (error.status === 409) {
    return "The request conflicts with the current state. Read the current state (for example the running timer) and try again.";
  }
  if (error.status >= 500) {
    return "The server failed. Retrying later may work; the server log has the real error.";
  }
  return null;
}

export function describeError(err: unknown): string {
  if (err instanceof ApiProblem) {
    const problem = err.problem;
    const slug = slugOf(problem?.type);
    const title = problem?.title ?? "Error";
    const lines = [
      `Track Your Time refused the request: ${err.status} ${title}${slug ? ` (${slug})` : ""}.`,
    ];
    if (problem?.detail) lines.push(problem.detail);
    const hint = hintFor(err);
    if (hint) lines.push(`Fix: ${hint}`);
    if (problem?.type) lines.push(`Problem type: ${problem.type}`);
    return lines.join("\n");
  }
  if (err instanceof ApiUnreachable) {
    return `${err.message}\nFix: check TRACKYOURTIME_API_URL and that the server is running. A self-hosted server answers GET /api/health.`;
  }
  if (err instanceof ApiUnexpectedResponse) {
    return `${err.message}\nFix: set TRACKYOURTIME_API_URL to the origin of your Track Your Time API, for example https://api.trackyourtime.dev or https://track.example.com.`;
  }
  if (err instanceof InputError) {
    return err.message;
  }
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

/** A mistake in the tool arguments that the API would not explain as well. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function errorResult(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(err) }] };
}

export function textResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  };
}

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function resolveZone(timeZone: string | undefined): string {
  if (timeZone === undefined) return hostTimeZone();
  if (!isValidTimeZone(timeZone)) {
    throw new InputError(`Unknown time zone "${timeZone}". Use an IANA name such as Europe/Berlin.`);
  }
  return timeZone;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Both bounds as instants, with a bare date read as a whole day in `timeZone`.
 *
 * The REST routes disagree about a bare `to`: the entry list reads
 * `2026-09-30` as midnight UTC at the START of that day, the reports read it as
 * the end of that day in the server's zone. A person asking for "September"
 * means neither exactly, so the tools resolve both bounds here, in the
 * caller's zone, and send full timestamps. `to` as a date is inclusive.
 */
export function resolveRange(
  from: string,
  to: string,
  timeZone: string,
): { from: string; to: string } {
  const fromMs = DATE_ONLY.test(from) ? zonedDayStartMs(from, timeZone) : Date.parse(from);
  const toMs = DATE_ONLY.test(to)
    ? zonedDayStartMs(addDaysToKey(to, 1), timeZone)
    : Date.parse(to);
  if (Number.isNaN(fromMs)) throw new InputError(`"from" is not a date: ${from}`);
  if (Number.isNaN(toMs)) throw new InputError(`"to" is not a date: ${to}`);
  if (toMs <= fromMs) {
    throw new InputError(`"to" (${to}) must be after "from" (${from}).`);
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

export function duration(seconds: number): string {
  return formatDurationShort(seconds);
}
