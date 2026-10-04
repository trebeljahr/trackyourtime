import type { QueuedMutation } from "./offline-queue.js";

export const DURABLE_ENTRY_OPS = ["entries.start", "entries.stop", "entries.create", "entries.update", "entries.remove", "entries.discard"] as const;
export type DurableEntryOp = (typeof DURABLE_ENTRY_OPS)[number];
export const isDurableEntryOp = (op: string): op is DurableEntryOp =>
  (DURABLE_ENTRY_OPS as readonly string[]).includes(op);

export type QueueExclusive = <T>(task: () => Promise<T>) => Promise<T>;

/** Fail closed when the host cannot serialize its shared persistent store. */
export const webQueueExclusive = (name: string): QueueExclusive => async (task) => {
  if (typeof navigator === "undefined" || !navigator.locks)
    throw new Error("This browser cannot safely save shared pending writes. Update it before recording time.");
  return navigator.locks.request(name, { mode: "exclusive" }, task);
};

const operationId = (): string => {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error("Secure operation identities are unavailable");
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Normalization happens once, before storage and before any network request. */
export const durableEntryPayload = (op: string, payload: unknown): unknown => {
  if (!isDurableEntryOp(op) || typeof payload !== "object" || payload === null) return payload;
  const stored = payload as { input?: unknown };
  if (typeof stored.input !== "object" || stored.input === null) return payload;
  const input = JSON.parse(JSON.stringify(stored.input)) as Record<string, unknown>;
  input.operationId ??= operationId();
  if (op === "entries.start") input.start ??= new Date().toISOString();
  if (op === "entries.stop") input.end ??= new Date().toISOString();
  return { ...stored, input };
};

/** Persist this exact object before sending it. Later edits cannot change a retry. */
export const freezeDurableEntry = (row: QueuedMutation): QueuedMutation => {
  if (!isDurableEntryOp(row.op) || row.submittedInput !== undefined) return row;
  const payload = durableEntryPayload(row.op, row.payload) as { input?: unknown };
  if (typeof payload?.input !== "object" || payload.input === null) return row;
  return {
    ...row,
    payload,
    submittedInput: JSON.parse(JSON.stringify({ ...payload.input, ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}) })),
  };
};

/** New protocol path: an old replica refuses before it can perform a write. */
export function durableEntryEnvelope<K extends DurableEntryOp, I extends object>(op: K, input: I): {
  operation: K; operationId: string; workspaceId?: string; input: Omit<I, "operationId" | "workspaceId">;
};
export function durableEntryEnvelope(op: string, input: unknown): {
  operation: DurableEntryOp; operationId: string; workspaceId?: string; input: Record<string, unknown>;
};
export function durableEntryEnvelope(op: string, input: unknown) {
  if (!isDurableEntryOp(op) || typeof input !== "object" || input === null)
    throw new Error("Invalid durable entry operation");
  const { operationId, workspaceId, ...payload } = input as Record<string, unknown>;
  if (typeof operationId !== "string") throw new Error("Missing durable operation identity");
  return { operation: op, operationId, ...(typeof workspaceId === "string" ? { workspaceId } : {}), input: payload };
}

export class DurableQueuedWriteError extends Error {
  constructor(readonly rowId: string, cause?: unknown) {
    super("This write is saved on this device and is waiting to sync", { cause });
    this.name = "DurableQueuedWriteError";
  }
}

export const durableQueuedWrite = (error: unknown): DurableQueuedWriteError | null => {
  const visited = new Set<unknown>();
  while (typeof error === "object" && error !== null && !visited.has(error)) {
    if (error instanceof DurableQueuedWriteError) return error;
    visited.add(error);
    error = (error as { cause?: unknown }).cause;
  }
  return null;
};

/** Bound exclusive queue ownership even when a connection never answers. */
export const durableRequestSignal = (previous?: AbortSignal | null): AbortSignal => {
  const controller = new AbortController();
  const abort = () => controller.abort(previous?.reason);
  if (previous?.aborted) abort();
  else previous?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    previous?.removeEventListener("abort", abort);
    controller.abort(new Error("Saved write request timed out"));
  }, 30_000);
  // Node commands must not live for another 30 seconds just for this timer.
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
};
