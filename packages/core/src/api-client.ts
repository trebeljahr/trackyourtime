/**
 * Thin caller over the tRPC HTTP endpoints, for clients that cannot use the
 * tRPC React bindings — the planned Raycast extension and Chrome extension.
 * The web client uses `@trpc/react-query` instead.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * HTTP statuses that mean "this request can never succeed", so a queued
 * mutation carrying one must be dropped rather than retried forever.
 *
 * 401/403 are deliberately absent: a lapsed session is recoverable, and
 * discarding someone's offline work because their token expired would be a
 * far worse bug than a queue that waits. 5xx are absent for the same reason.
 */
const PERMANENT_REJECTIONS = new Set([400, 404, 409, 410, 422]);

/**
 * True when the server refused a mutation for good.
 *
 * The case this exists for: the runaway guard capped a running entry on the
 * server while a device was offline holding a queued `entries.stop`. That stop
 * resolves against "whatever is running", finds nothing, and answers 404. It
 * can never succeed, and a queue that stops at it wedges every mutation behind
 * it — including the ones that would have replayed fine.
 */
export const isPermanentRejection = (error: unknown): boolean =>
  error instanceof ApiError && PERMANENT_REJECTIONS.has(error.httpStatus);

/**
 * True when a call never reached the server, so keeping the mutation is safe.
 *
 * `createApiClient` throws `ApiError` for everything the server answered —
 * 4xx and 5xx included — and lets the transport's own failure through
 * untouched. So "not an ApiError" is exactly "no answer came back", with no
 * message sniffing and no `navigator.onLine` to be wrong about. That matters
 * on Node, where `fetch` reports every transport failure as the same bare
 * "fetch failed": unreachable host, refused connection and bad DNS are
 * indistinguishable by message and identical in what they mean for a queue.
 *
 * A caller with errors of its own to exclude — "no session stored", say, which
 * is raised before a request exists — narrows this further rather than
 * replacing it.
 */
export const isTransportFailure = (error: unknown): boolean =>
  !(error instanceof ApiError);

export type ApiClientOptions = {
  /** Origin of the server, e.g. `https://api.trackyourtime.dev`. */
  baseUrl: string;
  /**
   * better-auth session token from `signInWithPassword()` or the device flow.
   * Omit to fall back to cookie auth (the web app's path).
   */
  token?: string;
  /** Names this client in Settings → Devices. Cosmetic, never a permission. */
  clientId?: string;
  fetchImpl?: typeof fetch;
};

export type ApiClient = {
  query<TResult>(path: string, input?: unknown): Promise<TResult>;
  mutate<TResult>(path: string, input?: unknown): Promise<TResult>;
};

type TrpcEnvelope = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string } };
};

const unwrap = (body: unknown, httpStatus: number): unknown => {
  if (typeof body !== "object" || body === null) {
    throw new ApiError("Malformed API response", "PARSE_ERROR", httpStatus);
  }
  const envelope = body as TrpcEnvelope;
  if (envelope.error) {
    throw new ApiError(
      envelope.error.message ?? "Request failed",
      envelope.error.data?.code ?? "INTERNAL_SERVER_ERROR",
      httpStatus
    );
  }
  return envelope.result?.data;
};

export const createApiClient = ({
  baseUrl,
  token,
  clientId,
  fetchImpl,
}: ApiClientOptions): ApiClient => {
  const doFetch =
    fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch?.bind(globalThis);

  if (!doFetch) {
    throw new Error("No fetch implementation available — pass `fetchImpl`.");
  }

  const headers = (): Record<string, string> => {
    const base: Record<string, string> = { "content-type": "application/json" };
    if (token) base.authorization = `Bearer ${token}`;
    if (clientId) base["x-tracktime-client"] = clientId;
    return base;
  };

  const call = async <TResult>(
    path: string,
    input: unknown,
    method: "GET" | "POST"
  ): Promise<TResult> => {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/trpc/${path}`);
    if (method === "GET" && input !== undefined) {
      url.searchParams.set("input", JSON.stringify(input));
    }

    const response = await doFetch(url.toString(), {
      method,
      headers: headers(),
      // Cookie auth for same-site browser callers; harmless with a token.
      credentials: token ? "omit" : "include",
      body: method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        `Request to ${path} failed (${response.status})`,
        "PARSE_ERROR",
        response.status
      );
    }

    return unwrap(body, response.status) as TResult;
  };

  return {
    query: (path, input) => call(path, input, "GET"),
    mutate: (path, input) => call(path, input, "POST"),
  };
};
