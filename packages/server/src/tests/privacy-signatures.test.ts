import assert from "node:assert/strict";
import { it } from "node:test";
import { createSigningPair, signPrivateChange } from "@starter/core";
import { verifyPrivateChange } from "../services/privacy/signatures.js";
import { beginPrivateMigration, requirePrivateWorkspaceRollout } from "../services/privacy/migration.js";
it("requires the existing private identity to change recovery, independent of login/reset", async () => {
  const owner = await createSigningPair(), intruder = await createSigningPair();
  const action = { userId: "owner", revision: 1, identity: { recovery: "opaque" } };
  const signature = await signPrivateChange(owner.privateKey, action);
  await verifyPrivateChange(owner.publicKey, action, signature);
  await verifyPrivateChange(owner.publicKey, { identity: action.identity, revision: 1, userId: "owner" }, signature);
  for (const next of [{ ...action, revision: 2 }, { ...action, userId: "other" }, { ...action, identity: { recovery: "replaced" } }]) await assert.rejects(verifyPrivateChange(owner.publicKey, next, signature));
  await assert.rejects(verifyPrivateChange(owner.publicKey, action, await signPrivateChange(intruder.privateKey, action)));
});
it("keeps incomplete workspace conversion unreachable before any database writes", async () => {
  assert.throws(requirePrivateWorkspaceRollout, /not available/);
  // The obsolete-protocol gate (requirePrivateClientProtocol) now refuses
  // begin first; either refusal comes before any database read or write.
  await assert.rejects(beginPrivateMigration("workspace", "owner", "hash", "signature"), { code: "NOT_IMPLEMENTED", message: /legacy private-data protocol is unavailable/ });
});
