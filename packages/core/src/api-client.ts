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
 * 401 is deliberately absent: a lapsed session is recoverable, and
 * discarding someone's offline work because their token expired would be a
 * far worse bug than a queue that waits. 5xx are absent for the same reason.
 *
 * 403 is present, and used not to be. In a shared workspace FORBIDDEN is a
 * verdict on ONE row by a session that is perfectly valid — a role change took
 * away a permission the row needed — so it cannot become valid by waiting or
 * by signing in again. Treating it as "the session is gone" stopped the flush
 * at that row, wedged every row behind it, and told the person to sign in to a
 * session they were already signed in to. A workspace the person has LEFT is
 * a different case with a different answer: its rows are held by the client
 * before they are sent (`isReplayableIn`), never refused one at a time here.
 */
const PERMANENT_REJECTIONS = new Set([400, 403, 404, 409, 410, 422]);

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
  error instanceof ApiError &&
  isPermanentRejectionStatus(error.code, error.httpStatus);

/**
 * The same verdict from a tRPC code and HTTP status, for a client whose errors
 * are not `ApiError` — the web app's `TRPCClientError` carries both in `data`.
 * One set for every queue, so a 500 or a 429 is kept on the phone exactly as
 * it is in the extension and Raycast.
 */
export const isPermanentRejectionStatus = (
  code: string,
  httpStatus: number,
): boolean =>
  // A status is only a verdict when the tRPC server gave it. A body that is
  // not a tRPC envelope (`PARSE_ERROR`) came from something in front of the
  // API — a WAF's HTML 403, a captive portal, a proxy answering `/api` with
  // the web app's 404 page mid-deploy — and says nothing about the row.
  // Dropping on it would delete queued time because a network was in the way.
  code !== "PARSE_ERROR" && PERMANENT_REJECTIONS.has(httpStatus);

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
  /**
   * The workspace this client is pointed at, read per request.
   *
   * Filled into any input that names none — an object without a
   * `workspaceId`, or no input at all — and never over one that does, so a
   * replayed offline row addressed to the workspace it was queued in keeps
   * that address. A getter, because the choice lives in the client's own
   * storage and can change between two calls. Returning null sends the input
   * unchanged, and the server resolves the session's default workspace.
   *
   * Per client on purpose: the extension and Raycast keep their own choice
   * and never follow the web app's session `activeOrganizationId`.
   */
  workspaceId?: () => string | null;
};

/**
 * `input` with `workspaceId` filled in when it names none.
 *
 * Only a plain object or `undefined` is addressed: a procedure whose input is
 * a bare string or an array has nowhere to carry a workspace, and wrapping it
 * would change what the server parses.
 */
export const withWorkspaceId = (
  input: unknown,
  workspaceId: string | null
): unknown => {
  if (workspaceId === null || workspaceId === "") return input;
  if (input === undefined) return { workspaceId };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as { workspaceId?: unknown };
  if (typeof record.workspaceId === "string" && record.workspaceId !== "") {
    return input;
  }
  return { ...record, workspaceId };
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
  workspaceId,
}: ApiClientOptions): ApiClient => {
  const doFetch =
    fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch?.bind(globalThis);

  if (!doFetch) {
    throw new Error("No fetch implementation available — pass `fetchImpl`.");
  }

  const headers = (): Record<string, string> => {
    const base: Record<string, string> = { "content-type": "application/json" };
    if (token) base.authorization = `Bearer ${token}`;
    if (clientId) base["x-trackyourtime-client"] = clientId;
    return base;
  };

  const call = async <TResult>(
    path: string,
    raw: unknown,
    method: "GET" | "POST"
  ): Promise<TResult> => {
    const input = workspaceId ? withWorkspaceId(raw, workspaceId()) : raw;
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
