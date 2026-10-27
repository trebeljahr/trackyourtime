const local = new WeakSet<object>();
/** Exact in-memory results only. Never serialized, inferred from a UI mode,
 * or reused as proof of server delivery. No decrypted payload is retained. */
export function markPrivateLocalResult<T>(result: T): T { if (result && typeof result === "object") local.add(result); return result; }
export const isPrivateLocalResult = (result: unknown): boolean => !!result && typeof result === "object" && local.has(result);
