import { createKeyPair, createSigningPair, randomSecret, encodeSecret, seal, privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, encryptPrivateRecord, signPrivateInitialProjectionRoot, privateRecordDigest, verifyPrivateInitialProjection, privateInitialSnapshotProjection, signPrivateWorkspacePolicy, createPrivateAccountInventorySync, memoryStorage, signPrivateAccountInventory, createPrivateWorkspaceReplica, privateReplicaIdentityFromDirectory, verifyPrivateWorkspaceRecoveryArchive, deriveRecoveryBackupKey } from "@starter/core";
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
export async function privateRecoveryFixture(padding = 0) {
  const pair = await createKeyPair(), signing = await createSigningPair(), master = randomSecret(), rawRecovery = randomSecret(), state = { open: true }, current = () => state.open;
  const secrets = { v: 1 as const, master: encodeSecret(master), privateKey: pair.privateKey, signingPrivateKey: signing.privateKey }, recoveryKey = encodeSecret(rawRecovery);
  const identity = { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, recovery: await seal(rawRecovery, secrets, `trackyourtime:identity:v1:${scope.server}:${scope.userId}`) }; rawRecovery.fill(0);
  const person = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([["owner", await privateMemberKeyFingerprint(scope.server, person)]]));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const tagValue = (id: string, name: string) => ({ _id: id, workspaceId: scope.workspaceId, createdBy: scope.userId, name, color: "#112233", archived: false, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" });
  const shared = [await encryptPrivateRecord(scope.workspaceId, { kind: "tags", id: "tag", authorId: null, value: { ...tagValue("tag", "Original private tag"), padding: "x".repeat(padding) } }, [person], 1)];
  const personal = [await encryptPrivateRecord(scope.workspaceId, { kind: "favorites", id: "favorite", authorId: "owner", value: { description: "Original private favorite" } }, [person], 1)];
  const root = await signPrivateInitialProjectionRoot({ directory, secrets, userId: "owner", migrationId: crypto.randomUUID(), sharedRecords: shared, ownerPersonalRecords: personal, personalDigests: new Map([["owner", await privateRecordDigest(personal)]]), current });
  const snapshot = await verifyPrivateInitialProjection({ signed: root, directory, secrets, scope, sharedRecords: privateInitialSnapshotProjection(shared, "owner"), personalRecords: privateInitialSnapshotProjection(personal, "owner"), current });
  const signedPolicy = await signPrivateWorkspacePolicy({ snapshot, directory, secrets, current });
  const inventoryOptions = { ...scope, storage: memoryStorage(), exclusive: <T>(work: () => Promise<T>) => work(), capture: () => () => { if (!current()) throw new Error("Locked recovery"); }, resolveStorageKey: () => ({ key: master, current }), resolveIdentity: () => ({ master, signingPrivateKey: signing.privateKey, signingPublicKey: signing.publicKey, current }) };
  const inventory = await createPrivateAccountInventorySync(inventoryOptions), enrollment = await signPrivateAccountInventory({ ...scope, workspaces: [{ workspaceId: scope.workspaceId, mode: "encrypted", signedPolicy }], previous: null, signingPrivateKey: signing.privateKey, current });
  await inventory.enroll(enrollment);
  const replica = await createPrivateWorkspaceReplica({ scope, storageKey: `replica:${snapshot.root}`, storage: memoryStorage(), exclusive: (work) => work(), resolveStorageKey: () => ({ key: master, current }), resolveIdentity: () => privateReplicaIdentityFromDirectory(directory, "owner", secrets, current) });
  await replica.bootstrapProjection(snapshot);
  await replica.enqueue({ records: [{ kind: "tags", id: "tag", authorId: null, value: tagValue("tag", "Unsent private rename") }], remove: [{ kind: "favorites", id: "favorite", authorId: "owner" }] });
  const offline = async () => { throw new Error("Offline after durable signing"); };
  try { await replica.flushOne({ commit: offline, changes: offline, chainedCommit: offline, chainedChanges: offline }); } catch (error) { if (!(error instanceof Error) || !error.message.includes("Offline after durable")) throw error; }
  await replica.enqueue({ records: [{ kind: "tags", id: "another", authorId: null, value: tagValue("another", "Another unsent private tag") }] });
  const capture = async () => verifyPrivateWorkspaceRecoveryArchive({ format: "trackyourtime-private-workspace-recovery-v1", ...scope, createdAt: new Date().toISOString(), identity, inventory: await inventory.exportRecovery(), directory: { signed: directory.signed, digest: directory.digest }, replica: await replica.exportRecovery() }, secrets, current);
  const archive = await capture(), key = await deriveRecoveryBackupKey(recoveryKey, scope);
  return { secrets, master, identity, recoveryKey, state, current, inventory, inventoryOptions, enrollment, replica, archive, key, capture };
}

/** Synthetic client setup only. Installs an explicitly signed test inventory
 * and complete local replica, without an API or migration route. */
export async function seedPrivateWorkspaceClient(f: Awaited<ReturnType<typeof privateRecoveryFixture>>) {
  const session = await import("./lib/private-session"), replicas = await import("./lib/private-replica"), inventories = await import("./lib/private-inventory-sync");
  session.installPrivateSession("owner", f.secrets);
  const account = await replicas.privateAccountInventoryStorageHost("owner");
  try { const sync = await inventories.privateAccountWorkspaceInventorySync("owner", account.storage, account.exclusive); await sync.enroll(f.enrollment); }
  finally { account.close(); }
  const host = await replicas.privateWorkspaceStorageHost("owner", "workspace");
  try {
    const directories = await replicas.privateDirectoryStore("owner", "workspace", host.storage, host.exclusive, { ownerId: "owner", signingPublicKey: f.identity.signingPublicKey }); await directories.accept(f.archive.directory.signed);
    const storage = await session.privateWorkspaceStorage("owner", "workspace", host.storage);
    await host.exclusive(() => storage.setItem(`replica:${f.archive.replica.activationRoot}`, JSON.stringify(f.archive.replica)));
  } finally { host.close(); }
}
