import assert from "node:assert/strict";
import { it } from "node:test";
import { beginPrivateMigration, stagePrivateMigration, privateMigrationArchive, commitPrivateMigration, requirePrivateClientProtocol } from "../services/privacy/migration.js";

// No database is connected: these obsolete entry points must refuse before
// lookup, source reading, server-side encryption or any destructive work.
it("permanently refuses obsolete begin/server-staging before the general rollout guard or database", async () => {
  const refusal = { code: "NOT_IMPLEMENTED", message: /legacy private-data protocol/ };
  assert.throws(requirePrivateClientProtocol, refusal);
  await assert.rejects(beginPrivateMigration("workspace", "owner", "a".repeat(64), "unused"), refusal);
  await assert.rejects(stagePrivateMigration("workspace", "owner", crypto.randomUUID(), 0), refusal);
});
it("keeps legacy complete archives and unverified source retirement independently refused", async () => {
  await assert.rejects(privateMigrationArchive("workspace", "owner", crypto.randomUUID()), { code: "NOT_IMPLEMENTED", message: /Legacy migration archives/ });
  await assert.rejects(commitPrivateMigration("workspace", "owner", crypto.randomUUID(), "a".repeat(64), "unused"), { code: "NOT_IMPLEMENTED", message: /verified source proof and chained snapshot/ });
});
