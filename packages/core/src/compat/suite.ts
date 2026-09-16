/**
 * The cross-version compatibility suite: what a client of THIS build needs a
 * Track Your Time server of any supported release to do.
 *
 * `.github/workflows/compat.yml` runs it in both directions — this build's
 * suite against the previous release's server, and the previous release's
 * suite against this build's server — so it only speaks through what real
 * clients use: core's api client, `session-auth.ts` and the offline queue.
 * Every assertion is about behaviour a person would notice: an account, a
 * timer, an entry, and above all queued time that is never lost.
 *
 * Old servers keep running this file for years, so it asks for nothing a
 * server could only have gained recently beyond what the handshake reports,
 * and it reads answers defensively. docs/versioning.md → Cross-version CI.
 */
import { API_LEVEL, CLIENT_TOO_OLD } from "@starter/shared";
import { ApiError, createApiClient, type ApiClient } from "../api-client.js";
import { createId } from "../ids.js";
import {
  createTempId,
  decodeOfflineMutation,
  holdBlocksReplay,
  tempIdOf,
  type StoredOfflinePayload,
} from "../offline-ops.js";
import { createOfflineQueue, type QueuedMutation } from "../offline-queue.js";
import {
  classifyReplayOutcome,
  flushVerdictFor,
  replayOfflineMutation,
  type OfflineReplayMutators,
  type ReplayOutcome,
} from "../offline-replay.js";
import {
  checkServer,
  describeServerVersion,
  serverCompatibility,
  type ServerInfo,
} from "../server-origin.js";
import { signInWithPassword, signUpWithPassword, type ClientId } from "../session-auth.js";
import { memoryStorage } from "../storage.js";

/**
 * A procedure path no server has ever had or will have. A queued row for it
 * stands in for every op a newer client can queue that an older server lacks
 * (`entries.discard` against a server from before it, say): the server's
 * answer is the same "No procedure found", and the row must be held.
 */
export const MISSING_PROCEDURE = "compat.procedureNoServerHas";

export class CompatFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatFailure";
  }
}

export type CompatOptions = {
  /** The server's origin, e.g. `http://127.0.0.1:51590`. */
  baseUrl: string;
  /** Sent as `x-trackyourtime-client-version`; optional and cosmetic. */
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export type CompatReport = {
  server: ServerInfo;
  /** `served`: the server accepts this build. `refused`: it answers CLIENT_TOO_OLD. */
  mode: "served" | "refused";
  clientApiLevel: number;
  checks: string[];
};

const CLIENT_ID: ClientId = "trackyourtime-cli";
const HOUR = 60 * 60 * 1000;

type EntryLike = { id?: unknown; end?: unknown; description?: unknown };

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new CompatFailure(message);
};

const idOf = (value: unknown, what: string): string => {
  const id = (value as EntryLike | null)?.id;
  assert(typeof id === "string" && id.length > 0, `${what} returned no entry id: ${JSON.stringify(value)}`);
  return id as string;
};

/** `entries.list` rows, from the `{ entries }` page or a bare array. */
const rowsOf = (value: unknown): EntryLike[] => {
  if (Array.isArray(value)) return value as EntryLike[];
  const entries = (value as { entries?: unknown } | null)?.entries;
  return Array.isArray(entries) ? (entries as EntryLike[]) : [];
};

const describeError = (error: unknown): string =>
  error instanceof ApiError
    ? `${error.code} ${error.httpStatus}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

/** Run every check against one server. Throws `CompatFailure` on the first miss. */
export async function runCompatSuite(options: CompatOptions): Promise<CompatReport> {
  const log = options.log ?? (() => undefined);
  const checks: string[] = [];
  const pass = (line: string): void => {
    checks.push(line);
    log(`ok   ${line}`);
  };

  // ── the server says who it is ─────────────────────────────────────────
  const checked = await checkServer(options.baseUrl, { fetchImpl: options.fetchImpl, timeoutMs: 15_000 });
  if (!checked.ok) throw new CompatFailure(`/api/health: ${checked.message}`);
  const server = checked.server;
  const verdict = serverCompatibility(server);
  log(
    `server: ${describeServerVersion(server)}, API level ${server.apiLevel}, ` +
      `serves clients from ${server.minClientApiLevel ?? "any"}; this suite is level ${API_LEVEL}` +
      (verdict ? `; first-party clients would answer ${verdict}` : ""),
  );
  pass("/api/health identifies a Track Your Time server with its database up");

  // ── an account, the way every client gets one ─────────────────────────
  const email = `compat-${Date.now()}-${createId().slice(0, 8)}@example.com`;
  const password = `Compat-${createId()}-pass`;
  const auth = {
    baseUrl: options.baseUrl,
    clientId: CLIENT_ID,
    clientVersion: options.clientVersion,
    fetchImpl: withOrigin(options.fetchImpl, server.webUrl),
  };
  const signedUp = await signUpWithPassword(auth, { email, password, name: "Compat Suite" }).catch(
    (error: unknown) => {
      throw new CompatFailure(`sign-up: ${describeError(error)}`);
    },
  );
  assert(signedUp.token.length > 0, "sign-up returned no session token");
  pass("sign-up returns a bearer session token");
  const signedIn = await signInWithPassword(auth, { email, password }).catch((error: unknown) => {
    throw new CompatFailure(`sign-in: ${describeError(error)}`);
  });
  pass("sign-in with the same password returns a session token");

  const api = createApiClient({
    baseUrl: options.baseUrl,
    token: signedIn.token,
    clientId: CLIENT_ID,
    clientVersion: options.clientVersion,
    fetchImpl: options.fetchImpl,
  });

  const refused = server.minClientApiLevel !== null && API_LEVEL < server.minClientApiLevel;
  if (refused) {
    await refusedChecks(api, pass);
  } else {
    await servedChecks(api, pass);
  }

  return { server, mode: refused ? "refused" : "served", clientApiLevel: API_LEVEL, checks };
}

// ── a server that serves this build ──────────────────────────────────────

async function servedChecks(api: ApiClient, pass: (line: string) => void): Promise<void> {
  const now = Date.now();
  const call = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new CompatFailure(`${what}: ${describeError(error)}`);
    }
  };

  const started = await call("entries.start", () =>
    api.mutate("entries.start", { description: "compat start", timeZone: "UTC", originId: createId() }),
  );
  const startedId = idOf(started, "entries.start");
  const current = await call("entries.current", () => api.query("entries.current", {}));
  assert(idOf(current, "entries.current") === startedId, "entries.current does not answer the timer just started");
  pass("entries.start starts a timer that entries.current reports");

  const stopped = await call("entries.stop", () =>
    api.mutate<EntryLike>("entries.stop", { id: startedId, originId: createId() }),
  );
  assert(idOf(stopped, "entries.stop") === startedId, "entries.stop stopped a different entry");
  assert(typeof stopped.end === "string" && stopped.end.length > 0, "entries.stop left the entry without an end");
  pass("entries.stop ends that timer");

  const created = await call("entries.create", () =>
    api.mutate("entries.create", {
      description: "compat create",
      start: new Date(now - 3 * HOUR).toISOString(),
      end: new Date(now - 2 * HOUR).toISOString(),
      timeZone: "UTC",
      originId: createId(),
    }),
  );
  const createdId = idOf(created, "entries.create");
  pass("entries.create records past time");

  // ── the offline queue ────────────────────────────────────────────────
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const tempId = createTempId();
  const common = { projectId: null, taskId: null, billable: false, source: "web", timeZone: "UTC" };
  await queue.enqueue("entries.start", {
    input: { ...common, description: "compat queued start", start: new Date(now - 90 * 60_000).toISOString(), originId: createId() },
    tempId,
  } satisfies StoredOfflinePayload);
  await queue.enqueue("entries.stop", {
    input: { end: new Date(now - 80 * 60_000).toISOString(), originId: createId() },
    tempId,
  } satisfies StoredOfflinePayload);
  await queue.enqueue(MISSING_PROCEDURE, { input: { originId: createId() } } satisfies StoredOfflinePayload);
  await queue.enqueue("entries.create", {
    input: {
      ...common,
      description: "compat queued create",
      start: new Date(now - 70 * 60_000).toISOString(),
      end: new Date(now - 60 * 60_000).toISOString(),
      originId: createId(),
    },
  } satisfies StoredOfflinePayload);

  const outcomes: { op: string; outcome: ReplayOutcome }[] = [];
  const runner = replayRunner(api, outcomes);

  const first = await queue.flush(runner, { chainOf: tempIdOf });
  assert(
    first.failed === undefined,
    `the flush stopped at ${first.failed?.op}: ${describeError(first.error)} (outcomes ${JSON.stringify(outcomes)})`,
  );
  const probe = outcomes.find((entry) => entry.op === MISSING_PROCEDURE)?.outcome;
  assert(
    probe?.kind === "hold" && probe.reason === "unknown-procedure",
    `a row for a procedure the server lacks was not held: ${JSON.stringify(probe)}`,
  );
  assert(first.flushed === 3, `expected 3 rows applied, got ${first.flushed} (${JSON.stringify(outcomes)})`);
  const left = await queue.list();
  assert(
    left.length === 1 && left[0]?.op === MISSING_PROCEDURE && left[0]?.hold?.reason === "unknown-procedure",
    `the queue should hold exactly the unsendable row, holds ${JSON.stringify(left.map(summary))}`,
  );
  pass("an offline flush applies what the server knows and holds a row for a procedure it lacks");

  // A later flush neither replays the held row early nor loses it, and a
  // forced retry (a launch, a resume) holds it again.
  const later = await queue.flush(runner, { chainOf: tempIdOf, filter: (row) => !holdBlocksReplay(row) });
  assert(later.flushed === 0 && later.remaining === 1, `a second flush changed the held row: ${JSON.stringify(later)}`);
  const retried = await queue.flush(runner, { chainOf: tempIdOf });
  assert(retried.held === 1 && retried.remaining === 1, `a forced retry dropped the held row: ${JSON.stringify(retried)}`);
  pass("the held row survives later flushes and a forced retry");

  const listed = rowsOf(
    await call("entries.list", () =>
      api.query("entries.list", {
        from: new Date(now - 24 * HOUR).toISOString(),
        to: new Date(now + HOUR).toISOString(),
        limit: 100,
      }),
    ),
  );
  const described = (text: string): EntryLike | undefined => listed.find((row) => row.description === text);
  assert(listed.some((row) => row.id === startedId), "entries.list is missing the stopped timer");
  assert(listed.some((row) => row.id === createdId), "entries.list is missing the created entry");
  const queuedStart = described("compat queued start");
  assert(queuedStart !== undefined, "the queued start never reached the server");
  assert(typeof queuedStart?.end === "string", "the queued stop did not end the queued start");
  assert(described("compat queued create") !== undefined, "the queued create never reached the server");
  pass("entries.list shows the online entries and the replayed queue");
}

// ── a server that refuses this build ─────────────────────────────────────

/**
 * A server whose floor is above this suite's level. The contract is a loud,
 * specific refusal — and queued time kept for a build that can send it.
 */
async function refusedChecks(api: ApiClient, pass: (line: string) => void): Promise<void> {
  const refusal = await api
    .mutate("entries.start", { description: "compat refused", timeZone: "UTC" })
    .then(() => null, (error: unknown) => error);
  assert(
    refusal instanceof ApiError && refusal.httpStatus === 412 && refusal.versionRefusal === CLIENT_TOO_OLD,
    `a refused client should get 412 CLIENT_TOO_OLD, got ${refusal === null ? "success" : describeError(refusal)}`,
  );
  pass("the server refuses this API level with 412 CLIENT_TOO_OLD");

  const queue = createOfflineQueue({ storage: memoryStorage() });
  const now = Date.now();
  await queue.enqueue("entries.create", {
    input: {
      description: "compat refused create",
      projectId: null,
      taskId: null,
      billable: false,
      source: "web",
      start: new Date(now - 2 * HOUR).toISOString(),
      end: new Date(now - HOUR).toISOString(),
      timeZone: "UTC",
      originId: createId(),
    },
  } satisfies StoredOfflinePayload);
  await queue.enqueue(MISSING_PROCEDURE, { input: { originId: createId() } } satisfies StoredOfflinePayload);
  const outcomes: { op: string; outcome: ReplayOutcome }[] = [];
  const result = await queue.flush(replayRunner(api, outcomes), { chainOf: tempIdOf });
  assert(result.failed !== undefined, "a refused flush reported success");
  assert((await queue.size()) === 2, `a refused flush dropped rows: ${JSON.stringify(outcomes)}`);
  pass("a flush the server refuses keeps every queued row");
}

// ── replay ───────────────────────────────────────────────────────────────

/**
 * The runner a real client hands to `flush`: decoded rows through
 * `replayOfflineMutation`, anything else sent as-is, every failure judged by
 * core's shared classifier.
 */
function replayRunner(
  api: ApiClient,
  outcomes: { op: string; outcome: ReplayOutcome }[],
): (row: QueuedMutation) => Promise<void | { hold: "unknown-op" | "unknown-procedure" }> {
  const mutators = new Proxy({} as OfflineReplayMutators, {
    get: (_target, op: string) => (input: unknown) => api.mutate(op, input),
  });
  const watcher = { noteServerId: () => undefined };
  const resolved = new Map<string, string>();

  return async (row) => {
    try {
      const decoded = decodeOfflineMutation(row);
      if (decoded) {
        await replayOfflineMutation(mutators, watcher, decoded, { createdAt: row.createdAt, resolved });
      } else {
        await api.mutate(row.op, (row.payload as StoredOfflinePayload).input);
      }
      outcomes.push({ op: row.op, outcome: { kind: "applied" } });
      return undefined;
    } catch (error) {
      const outcome = await classifyReplayOutcome(error, row);
      outcomes.push({ op: row.op, outcome });
      return flushVerdictFor(outcome, error);
    }
  };
}

/**
 * `fetch` that sends the server's own web origin when a request names none.
 *
 * Node's fetch adds `Sec-Fetch-Mode: cors` to every request, and better-auth
 * then insists on a trusted `Origin` before it looks at a password. The web
 * app's origin is the one every server trusts, and `/api/health` names it.
 */
function withOrigin(fetchImpl: typeof fetch | undefined, webUrl: string | null): typeof fetch {
  const base = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let origin: string | null = null;
  try {
    origin = webUrl ? new URL(webUrl).origin : null;
  } catch {
    origin = null;
  }
  if (origin === null) return base;
  const trusted = origin;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("origin")) headers.set("origin", trusted);
    return base(input, { ...init, headers });
  };
}

const summary = (row: QueuedMutation): { op: string; hold: string | null } => ({
  op: row.op,
  hold: row.hold?.reason ?? null,
});
