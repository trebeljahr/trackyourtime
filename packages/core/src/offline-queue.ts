import { createId } from "./ids.js";
import { sameServerOrigin } from "./server-origin.js";
import type { KeyValueStorage } from "./storage.js";

export type QueuedMutation = {
  id: string;
  op: string;
  payload: unknown;
  createdAt: string;
  /**
   * The account this row was queued under.
   *
   * Optional, and it has to stay optional: rows written by a build that
   * predates ownership stamping decode without it, and one of those rows is
   * time the user tracked that no server has ever seen. `undefined` means
   * "nobody has claimed this yet" — see `adoptUnowned`.
   *
   * A raw user id rather than a hash of one. The check this field exists for
   * is an equality test that decides whose workspace a start is written into,
   * and a short non-cryptographic hash would make that test probabilistic:
   * one collision reintroduces exactly the cross-account replay the stamp is
   * here to prevent. The value never leaves the device, and it sits beside a
   * session token in the same store.
   */
  owner?: string;
  /**
   * The server origin this row was queued against.
   *
   * A client can be pointed at a different server, and a queued start replayed
   * into the wrong one is tracked time filed on a server the person has left
   * — or, worse, one where the same email belongs to someone else. So a row
   * replays only against the origin it was made for. Optional for the same
   * reason `owner` is: rows from before the stamp decode without it, and they
   * were all made against the build's default server — see `isQueuedOn`.
   */
  server?: string;
  /**
   * The workspace this row was queued in.
   *
   * A person can belong to several workspaces and switch between them while a
   * row waits, and a replay addresses whichever workspace the client points
   * at NOW unless the row names one. So a start queued in A and replayed
   * after a switch to B would be filed in B — time billed to the wrong client
   * with nothing on screen to say so. The stamp is sent as the request's
   * explicit `workspaceId` on replay (`replayOfflineMutation`), which the
   * server resolves before anything else.
   *
   * Optional forever, like `owner`: rows from before the stamp decode without
   * it, and the first workspace a client resolves adopts them
   * (`adoptUnstampedWorkspace`).
   */
  workspaceId?: string;
};

export type OfflineQueue = {
  enqueue(
    op: string,
    payload: unknown,
    owner?: string,
    server?: string,
    workspaceId?: string
  ): Promise<QueuedMutation>;
  list(): Promise<QueuedMutation[]>;
  size(): Promise<number>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /**
   * Stamp every row that carries no owner with `owner`, and report how many
   * were claimed. The first account to sign in after an upgrade adopts the
   * rows the old build left behind — they are almost certainly its own, and
   * the alternative to claiming them is either stranding them forever or
   * letting the account after next replay them.
   */
  adoptUnowned(
    owner: string,
    where?: (mutation: QueuedMutation) => boolean
  ): Promise<number>;
  /**
   * Stamp every row that names no server with `server`, and report how many.
   *
   * For a client whose build default is not where its old rows went — Raycast,
   * whose server has always been a preference — the honest owner of an
   * unstamped row is the server in use when this build first ran, so it
   * claims them once, eagerly, before the preference can change.
   */
  adoptUnserved(server: string): Promise<number>;
  /**
   * Stamp every row that names no workspace with `workspaceId`, and report how
   * many. Same semantics as `adoptUnowned`: the first workspace a client
   * resolves after an upgrade claims the rows the old build left behind,
   * because that is where they would have replayed anyway — and claiming them
   * once, eagerly, keeps a later switch from carrying them along.
   */
  adoptUnstampedWorkspace(
    workspaceId: string,
    where?: (mutation: QueuedMutation) => boolean
  ): Promise<number>;
  /**
   * Run `runner` over the queue in order, dropping each mutation as it
   * succeeds. Stops at the first failure and leaves that mutation (and
   * everything after it) queued, so ordering is never broken by a retry.
   *
   * `options.filter` decides which rows are the runner's business. A row it
   * rejects is neither run nor dropped: it keeps its place in the queue and
   * is counted in `skipped`. That is what lets one device hold another
   * account's queued work without either replaying it or destroying it.
   */
  flush(
    runner: (mutation: QueuedMutation) => Promise<void>,
    options?: FlushOptions
  ): Promise<FlushResult>;
};

export type FlushOptions = {
  /** Rows this predicate rejects stay queued, untouched and unreplayed. */
  filter?: (mutation: QueuedMutation) => boolean;
};

export type FlushResult = {
  flushed: number;
  remaining: number;
  /** Rows the filter held back. They are part of `remaining`. */
  skipped: number;
  /** The mutation that failed, if the flush stopped early. */
  failed?: QueuedMutation;
  error?: unknown;
};

const isQueuedMutation = (value: unknown): value is QueuedMutation => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.op === "string" &&
    typeof record.createdAt === "string"
  );
};

/**
 * An `owner` that is not a string is no owner at all. Anything else would let
 * a corrupt or hand-edited row compare equal to nothing and sit in the queue
 * forever, or — worse — compare equal to whatever `undefined` is treated as.
 */
const normalize = (mutation: QueuedMutation): QueuedMutation => {
  const owner =
    typeof mutation.owner === "string" && mutation.owner.length > 0
      ? mutation.owner
      : undefined;
  const server =
    typeof mutation.server === "string" && mutation.server.length > 0
      ? mutation.server
      : undefined;
  const workspaceId =
    typeof mutation.workspaceId === "string" && mutation.workspaceId.length > 0
      ? mutation.workspaceId
      : undefined;
  if (
    owner === mutation.owner &&
    server === mutation.server &&
    workspaceId === mutation.workspaceId
  ) {
    return mutation;
  }
  const normalized: QueuedMutation = { ...mutation, owner, server };
  // Only written when present, so a row that never had the field reads back
  // exactly as it was stored.
  if (workspaceId === undefined) delete normalized.workspaceId;
  else normalized.workspaceId = workspaceId;
  return normalized;
};

/**
 * True when `owner` may replay `mutation`.
 *
 * Unowned rows are replayable by whoever is signed in, which is the same
 * decision `adoptUnowned` makes eagerly — the two must agree, or a row could
 * be adopted by one account and replayed by another. Nobody replays anything
 * while signed out.
 */
export const isReplayableBy = (
  mutation: Pick<QueuedMutation, "owner">,
  owner: string | null
): boolean => {
  if (owner === null) return false;
  return mutation.owner === undefined || mutation.owner === owner;
};

/**
 * True when `mutation` demonstrably belongs to somebody else.
 *
 * The negation of `isReplayableBy` in every case but one: an unowned row is
 * not foreign to a caller who does not know who it is yet. Replaying such a
 * row is a decision that must wait for an account (`isReplayableBy` refuses
 * it); merely reading or cancelling it is not.
 */
export const isForeignTo = (
  mutation: Pick<QueuedMutation, "owner">,
  owner: string | null
): boolean => mutation.owner !== undefined && mutation.owner !== owner;

/**
 * True when `mutation` was queued against `server`.
 *
 * `legacyServer` answers for rows written before the server stamp existed.
 * Every one of those was made against the client's built-in default — no
 * client could be pointed anywhere else yet — so that is the server they
 * belong to, whichever one the client uses today. Comparing against the
 * CURRENT server instead would hand them to whichever server the person
 * switched to first.
 */
export const isQueuedOn = (
  mutation: Pick<QueuedMutation, "server">,
  server: string,
  legacyServer: string
): boolean => sameServerOrigin(mutation.server ?? legacyServer, server);

/**
 * True when a row may be replayed by someone whose memberships are
 * `memberWorkspaceIds`.
 *
 * A stamped row replays only into a workspace the person still belongs to. A
 * row for a workspace they have left or been removed from must not be sent at
 * all: the server would refuse it (NOT_FOUND), the flush would drop it as a
 * permanent refusal, and a day of tracked time would vanish with a toast. It
 * must not be retargeted either — that is the cross-workspace replay the stamp
 * exists to prevent. So it is held: kept, counted, and described until the
 * person discards it deliberately.
 *
 * An unstamped row is replayable, the same decision `isReplayableBy` makes for
 * an unowned one — and the same decision `adoptUnstampedWorkspace` makes
 * eagerly. Clients adopt before they flush, so in practice only a row that
 * slipped in between the two reaches this unstamped.
 */
export const isReplayableIn = (
  mutation: Pick<QueuedMutation, "workspaceId">,
  memberWorkspaceIds: ReadonlySet<string>
): boolean =>
  mutation.workspaceId === undefined ||
  memberWorkspaceIds.has(mutation.workspaceId);

/**
 * True when a row demonstrably belongs to a workspace the person is not in.
 *
 * The negation of `isReplayableIn` for every stamped row; an unstamped row is
 * never foreign, because it names no workspace to be foreign to.
 */
export const isForeignWorkspace = (
  mutation: Pick<QueuedMutation, "workspaceId">,
  memberWorkspaceIds: ReadonlySet<string>
): boolean =>
  mutation.workspaceId !== undefined &&
  !memberWorkspaceIds.has(mutation.workspaceId);

/**
 * The pure half of `OfflineQueue.adoptUnstampedWorkspace`: `rows` with every
 * unstamped row (that `where` accepts) stamped with `workspaceId`. Rows that
 * already name a workspace are returned untouched — adoption never moves a
 * row from one workspace to another.
 */
export const adoptUnstampedWorkspace = (
  rows: readonly QueuedMutation[],
  workspaceId: string,
  where?: (mutation: QueuedMutation) => boolean
): QueuedMutation[] =>
  rows.map((row) =>
    row.workspaceId === undefined && (where === undefined || where(row))
      ? { ...row, workspaceId }
      : row
  );

/**
 * Durable FIFO of mutations made while offline or during a failed request.
 *
 * The queue is the reason start/stop works with the network fully off: the
 * optimistic cache update stands, the mutation waits here, and the flush on
 * reconnect replays it in the order the user performed it.
 */
export const createOfflineQueue = ({
  storage,
  key = "trackyourtime.offline-queue",
}: {
  storage: KeyValueStorage;
  key?: string;
}): OfflineQueue => {
  const read = async (): Promise<QueuedMutation[]> => {
    const raw = await storage.getItem(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(isQueuedMutation).map(normalize)
        : [];
    } catch {
      // Corrupt payload — better to drop the queue than to wedge the app.
      return [];
    }
  };

  const write = async (mutations: QueuedMutation[]): Promise<void> => {
    if (mutations.length === 0) {
      await storage.removeItem(key);
      return;
    }
    await storage.setItem(key, JSON.stringify(mutations));
  };

  // Serialize access so two concurrent enqueues can't clobber each other
  // through the read-modify-write window.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    enqueue: (op, payload, owner, server, workspaceId) =>
      serial(async () => {
        const mutation: QueuedMutation = {
          id: createId(),
          op,
          payload,
          createdAt: new Date().toISOString(),
          owner,
          server,
          ...(workspaceId ? { workspaceId } : {}),
        };
        const mutations = await read();
        mutations.push(mutation);
        await write(mutations);
        return mutation;
      }),

    list: () => serial(read),

    size: () => serial(async () => (await read()).length),

    remove: (id) =>
      serial(async () => {
        const mutations = await read();
        await write(mutations.filter((m) => m.id !== id));
      }),

    clear: () => serial(async () => write([])),

    adoptUnowned: (owner, where) =>
      serial(async () => {
        const mutations = await read();
        // `where` keeps an account from claiming rows it could never have
        // made: an account on one server adopting a row queued against another.
        const claimable = (m: QueuedMutation): boolean =>
          m.owner === undefined && (where === undefined || where(m));
        const unowned = mutations.filter(claimable);
        if (unowned.length === 0) return 0;
        await write(mutations.map((m) => (claimable(m) ? { ...m, owner } : m)));
        return unowned.length;
      }),

    adoptUnserved: (server) =>
      serial(async () => {
        const mutations = await read();
        const unserved = mutations.filter((m) => m.server === undefined);
        if (unserved.length === 0) return 0;
        await write(
          mutations.map((m) => (m.server === undefined ? { ...m, server } : m))
        );
        return unserved.length;
      }),

    adoptUnstampedWorkspace: (workspaceId, where) =>
      serial(async () => {
        const mutations = await read();
        const next = adoptUnstampedWorkspace(mutations, workspaceId, where);
        const adopted = next.filter(
          (row, index) => row !== mutations[index]
        ).length;
        if (adopted === 0) return 0;
        await write(next);
        return adopted;
      }),

    flush: (runner, options) =>
      serial(async () => {
        const mutations = await read();
        const wanted = options?.filter ?? (() => true);
        // Rows the filter held back, in order, so they can be written back
        // ahead of whatever is still unprocessed when a flush stops early.
        const kept: QueuedMutation[] = [];
        let flushed = 0;

        for (const [index, mutation] of mutations.entries()) {
          if (!wanted(mutation)) {
            kept.push(mutation);
            continue;
          }
          try {
            await runner(mutation);
            flushed += 1;
          } catch (error) {
            const remaining = [...kept, ...mutations.slice(index)];
            await write(remaining);
            return {
              flushed,
              skipped: kept.length,
              remaining: remaining.length,
              failed: mutation,
              error,
            };
          }
        }

        await write(kept);
        return { flushed, skipped: kept.length, remaining: kept.length };
      }),
  };
};
