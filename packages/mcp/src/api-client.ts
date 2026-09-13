// A thin client for `/api/v1`.
//
// Deliberately not generated from the OpenAPI document and deliberately not
// typed per route: every tool hands its JSON straight to the model, so a typed
// response buys nothing but a second place for a field list to go stale. What
// this file owns is the two things that are easy to get wrong — the query
// encoding the server's schema-directed coercion expects, and turning every
// failure into a sentence a person can act on.

import type { McpConfig } from "./config.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** RFC 9457, as `/api/v1` writes it. Every field is present on every problem. */
export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;

/** A refusal the server answered with a problem document (or at least a status). */
export class ApiProblem extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;
  readonly retryAfterSec: number | null;

  constructor(status: number, problem: ProblemDetails | null, retryAfterSec: number | null) {
    super(problem?.detail ?? `HTTP ${status}`);
    this.name = "ApiProblem";
    this.status = status;
    this.problem = problem;
    this.retryAfterSec = retryAfterSec;
  }
}

/** No answer came back at all: DNS, refused connection, TLS, timeout. */
export class ApiUnreachable extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    const reason = describeCause(cause);
    super(`Could not reach ${url}: ${reason}`);
    this.name = "ApiUnreachable";
    this.url = url;
  }
}

/** An answer came back, but not from this API (an HTML page, a proxy error). */
export class ApiUnexpectedResponse extends Error {
  readonly status: number;

  constructor(url: string, status: number, contentType: string | null) {
    super(
      `${url} answered HTTP ${status} with ${contentType ?? "no content type"}, not JSON. ` +
        "The URL probably does not point at a Track Your Time API.",
    );
    this.name = "ApiUnexpectedResponse";
    this.status = status;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    // Node's fetch throws a bare "fetch failed" and puts the useful part on
    // `cause` (ECONNREFUSED, ENOTFOUND, a certificate error).
    const inner = (cause as { cause?: unknown }).cause;
    if (inner instanceof Error) {
      const code = (inner as { code?: unknown }).code;
      return typeof code === "string" ? `${code} (${inner.message})` : inner.message;
    }
    return cause.name === "TimeoutError" ? "the request timed out" : cause.message;
  }
  return String(cause);
}

/**
 * Encode a query the way `/api/v1` reads it.
 *
 * Arrays become repeated keys, booleans and numbers their string form, and
 * absent values are left out entirely — sending `billable=` would be coerced
 * and rejected, where leaving it out means "no filter".
 */
export function encodeQuery(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function isProblem(value: unknown): value is ProblemDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.status === "number" && typeof candidate.detail === "string";
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
};

export type ApiEnvelope = { data: unknown; nextCursor?: string | null; [extra: string]: unknown };

const REQUEST_TIMEOUT_MS = 30_000;

export class RestClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;

  constructor(config: McpConfig, options: { fetch?: FetchLike; userAgent?: string } = {}) {
    this.base = `${config.apiUrl}/api/v1`;
    this.token = config.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent ?? "trackyourtime-mcp";
  }

  get baseUrl(): string {
    return this.base;
  }

  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiEnvelope> {
    const url = `${this.base}${path}${options.query ? encodeQuery(options.query) : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json, application/problem+json",
      "User-Agent": this.userAgent,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiUnreachable(url, err);
    }

    const contentType = response.headers.get("content-type");
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiUnexpectedResponse(url, response.status, contentType);
    }

    if (!response.ok) {
      throw new ApiProblem(
        response.status,
        isProblem(json) ? json : null,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (!json || typeof json !== "object" || !("data" in json)) {
      throw new ApiUnexpectedResponse(url, response.status, contentType);
    }
    return json as ApiEnvelope;
  }
}
