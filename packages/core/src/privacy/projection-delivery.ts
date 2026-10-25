import { z } from "zod";
import { encryptedRecordSchema, PRIVATE_SNAPSHOT_MAX_BYTES, PRIVATE_SNAPSHOT_PAGE_MAX_BYTES, signedPrivateInitialProjectionRootSchema } from "@starter/shared";
import type { PublicKey } from "./crypto.js";
import type { VerifiedPrivateDirectory } from "./directory.js";
import type { PrivateStorageScope } from "./storage.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { verifyPrivateInitialProjection, verifyPrivateInitialProjectionRoot } from "./projection-snapshot.js";

const pageSchema = z.object({ offset: z.number().int().nonnegative().max(400_000), next: z.number().int().positive().max(400_000).nullable(), records: z.array(encryptedRecordSchema).max(100) }).strict();
const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input)).length;
export type PrivateProjectionTransport = {
  root: () => Promise<unknown>;
  page: (input: { migrationId: string; lane: "shared" | "personal"; offset: number }) => Promise<unknown>;
};
/** Fetch bounded independent projections, then authenticate their exact content.
 * expectedRoot must come from trusted activation/device/recovery state, not the
 * same untrusted response. This loader cannot establish global freshness when
 * every trusted checkpoint has been lost. Nothing is persisted before success. */
export async function loadPrivateInitialProjection(options: {
  transport: PrivateProjectionTransport; expectedRoot: string; scope: PrivateStorageScope;
  directory: VerifiedPrivateDirectory; secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}) {
  const { transport, expectedRoot, directory, secrets, current } = options, scope = structuredClone(options.scope);
  const check = () => { if (!current()) throw new Error("Private projection changed during delivery"); };
  check();
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedRoot)) throw new Error("A trusted initial projection root is required");
  const raw = await transport.root(); check();
  if (bytes(raw) > 256 * 1024) throw new Error("Initial projection root exceeds its size bound");
  const signed = await verifyPrivateInitialProjectionRoot({ signed: signedPrivateInitialProjectionRootSchema.parse(raw), scope, directory, secrets, current }); check();
  if (await privateRecordDigest(signed.manifest) !== expectedRoot) throw new Error("Initial projection differs from the trusted root");
  check();
  let totalBytes = bytes(signed), totalRecords = 0;
  async function lane(lane: "shared" | "personal") {
    const records = []; let offset: number | null = 0;
    do {
      const raw = await transport.page({ migrationId: signed.manifest.migrationId, lane, offset }); check();
      const length = bytes(raw);
      if (length > PRIVATE_SNAPSHOT_PAGE_MAX_BYTES + 1024) throw new Error("Initial projection page exceeds its size bound");
      const page = pageSchema.parse(raw);
      if (page.offset !== offset || (page.next !== null && (!page.records.length || page.next !== offset + page.records.length))) throw new Error("Invalid initial projection page boundary");
      totalBytes += bytes(page.records); totalRecords += page.records.length;
      if (totalBytes > PRIVATE_SNAPSHOT_MAX_BYTES || totalRecords > 400_000) throw new Error("Initial projection exceeds its size bound");
      records.push(...page.records); offset = page.next;
    } while (offset !== null);
    return records;
  }
  const sharedRecords = await lane("shared"), personalRecords = await lane("personal"); check();
  const snapshot = await verifyPrivateInitialProjection({ signed, sharedRecords, personalRecords, scope, directory, secrets, current }); check();
  return snapshot;
}
