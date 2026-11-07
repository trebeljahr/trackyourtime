/**
 * Everything the owner's device signs to create an encrypted workspace from
 * its first record (docs/private-workspace-protocol.md → "Creating an
 * encrypted workspace"): the owner-only key directory, the initial projection
 * holding just the encrypted workspace name, the verified snapshot the local
 * replica starts from, and the signed policy the account inventory lists.
 * The server receives `directory`, `root` and `records`; the rest stays here.
 */
import type { PublicKey } from "./crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "./directory.js";
import { encryptPrivateRecord } from "./records.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { privateInitialSnapshotProjection } from "./initial-snapshot.js";
import { signPrivateInitialProjectionRoot, sortInitialProjectionRecords, verifyPrivateInitialProjection } from "./projection-snapshot.js";
import { signPrivateWorkspacePolicy } from "./mode-policy.js";

type Secrets = { v: 1; master: string; privateKey: PublicKey; signingPrivateKey: PublicKey };

export async function prepareEncryptedWorkspace(options: {
  server: string; workspaceId: string; userId: string; name: string; createdAt: string; reportRangeTimeZone: string;
  currency: string; weekStartsOn: 0 | 1;
  publicKey: PublicKey; signingPublicKey: PublicKey; secrets: Secrets; current: () => boolean;
}) {
  const { server, workspaceId, userId, secrets, current } = options;
  const scope = { server, workspaceId, userId };
  const owner = { userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: options.publicKey, signingPublicKey: options.signingPublicKey };
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, server, workspaceId, ownerId: userId, revision: 1, previousDigest: null, members: [owner] }, secrets.signingPrivateKey, null, new Map([[userId, await privateMemberKeyFingerprint(server, owner)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, scope, { ownerId: userId, signingPublicKey: options.signingPublicKey, revision: 0, digest: null });
  // The name the workspace list shows; the server keeps a placeholder.
  const identity = await encryptPrivateRecord(workspaceId, { kind: "workspaceIdentity", id: "organization", authorId: null,
    value: { workspaceId, organization: { _id: workspaceId, id: workspaceId, name: options.name.trim().slice(0, 100), kind: "team", createdAt: options.createdAt } } }, [owner], 1);
  // What every converted workspace carries and the entry, catalog and report
  // views read: the settings and the owner's membership, each with its money
  // half (paired by id).
  const memberId = `member-${userId}`;
  const settings = await encryptPrivateRecord(workspaceId, { kind: "settings", id: "settings", authorId: null, value: { _id: "settings", workspaceId, currency: options.currency, weekStartsOn: options.weekStartsOn } }, [owner], 1);
  const settingsMoney = await encryptPrivateRecord(workspaceId, { kind: "settingsMoney", id: "settings", authorId: null, value: { _id: "settings", defaultHourlyRate: null } }, [owner], 1);
  const member = await encryptPrivateRecord(workspaceId, { kind: "members", id: memberId, authorId: userId, value: { _id: memberId, workspaceId, userId } }, [owner], 1);
  const memberMoney = await encryptPrivateRecord(workspaceId, { kind: "memberMoney", id: memberId, authorId: userId, value: { _id: memberId, hourlyRate: null } }, [owner], 1);
  const shared = sortInitialProjectionRecords([identity, settings, settingsMoney, member, memberMoney]), personal: typeof shared = [];
  const root = await signPrivateInitialProjectionRoot({ directory, secrets, userId, migrationId: crypto.randomUUID(), sharedRecords: shared, ownerPersonalRecords: personal, personalDigests: new Map([[userId, await privateRecordDigest(personal)]]), current });
  const snapshot = await verifyPrivateInitialProjection({ signed: root, directory, secrets, scope, sharedRecords: privateInitialSnapshotProjection(shared, userId), personalRecords: privateInitialSnapshotProjection(personal, userId), current });
  const signedPolicy = await signPrivateWorkspacePolicy({ reportRangeTimeZone: options.reportRangeTimeZone, snapshot, directory, secrets, current });
  return { signedDirectory, directory, root, records: [...shared, ...personal], snapshot, signedPolicy };
}
