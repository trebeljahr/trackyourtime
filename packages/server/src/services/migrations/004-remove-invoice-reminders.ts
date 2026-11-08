import type { Db } from "mongodb";
import type { Migration } from "./types.js";

/** The index the removed reminder job scanned by, as the schema declared it. */
export const REMINDER_INDEX_KEYS = { "followThrough.reminders.enabled": 1, _id: 1 } as const;
/** The removed job's lease row in `scheduledjobs`. */
export const REMINDER_JOB_NAME = "invoice-reminders";

const isNamespaceNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === 26;

/**
 * Payment reminders are gone (2026-11-08): emails sent to a customer in the
 * issuer's name without them seeing each one read as spam. This removes what
 * the feature stored, so no recipient address or consent record outlives it:
 * `followThrough.reminders` on every invoice (recipient, timezone, consent,
 * delivery history), the index the job scanned by, and the job's lease row.
 *
 * Readable by every release (`minReaderSchema` 0): an older build reads an
 * invoice without reminders as "never switched on", which it already handles.
 * An older build that boots afterwards rebuilds the index and its job finds
 * nothing to send.
 *
 * Idempotent: a re-run unsets nothing, finds no index and no row.
 */
export const removeInvoiceReminders: Migration = {
  id: 4,
  description: "remove stored invoice payment reminders, their index and job row",
  minReaderSchema: 0,
  up: async (db: Db) => {
    await db.collection("invoices").updateMany(
      { "followThrough.reminders": { $exists: true } },
      { $unset: { "followThrough.reminders": "" } },
    );

    let indexes: { name?: string; key: Record<string, unknown> }[] = [];
    try {
      indexes = (await db.collection("invoices").listIndexes().toArray()) as typeof indexes;
    } catch (error) {
      if (!isNamespaceNotFound(error)) throw error;
    }
    const wanted = Object.entries(REMINDER_INDEX_KEYS);
    for (const index of indexes) {
      const keys = Object.entries(index.key);
      const same = keys.length === wanted.length && keys.every(([field, dir], i) => field === wanted[i]![0] && Number(dir) === wanted[i]![1]);
      if (!same || !index.name) continue;
      try {
        await db.collection("invoices").dropIndex(index.name);
      } catch (error) {
        // A leftover index costs a little on writes and nothing else: never stop the boot for it.
        console.warn(`[migrations] Kept invoices.${index.name}; drop it by hand: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await db.collection("scheduledjobs").deleteMany({ name: REMINDER_JOB_NAME });
  },
};
