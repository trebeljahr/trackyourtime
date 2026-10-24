# Private workspace edits

The workspace rollout guard is unconditional. `privacy.signedWrite` and
`privacy.changes` cannot be enabled with an environment variable. Standard
workspaces and their existing clients keep their current behavior.

## Signed edits and immutable feeds

An unlocked writer encrypts records to verified member encryption keys. Each
record binds its workspace, kind, ID, author and revision as authenticated data.
The writer signs a canonical manifest of the complete ciphertext hashes,
recipients, removals, operation ID and expected workspace revision. Each member
also receives a separate signature over their own projection, including an
empty projection when the edit contains no records they may read. Other
members' private record IDs, kinds and counts are excluded from that projection.
The writer ID, operation ID and global revision remain routing metadata.

The server verifies signatures and current membership permissions, serializes
edits through the workspace write fence, and commits the materialized records,
immutable journal entry and revision in one MongoDB snapshot transaction.
Workspace operation IDs are durable replay receipts. An identical retry returns
its original revision even after later saves; reusing the ID for another
manifest fails. No authentication credential can create a new signed edit.

A client must supply independently verified member signing keys. A key supplied
by the change response is never trusted. It verifies every consecutive revision,
its reader-specific signature, complete ciphertext hashes and ciphertext
authentication before advancing its durable checkpoint. Journal pagination fixes
an upper bound on its first page. Later writes cannot replace earlier pages.
Missing revisions, unexpected recipients, altered records and unsigned omissions
fail closed. A newly added member needs a fresh verified snapshot before reading
history without a signed projection for that account.

## Verified sharing directory

The core directory is signed by its previously trusted owner. It binds the
server origin, workspace, member encryption/signing keys, roles and visibility
flags to a consecutive revision and previous digest. An ownership transfer
requires the old owner's signature; later revisions use the new owner's key.
New or changed member keys require fingerprints checked independently of the
API response before the owner can sign them. Curve points and public-only keys
are checked before accepting a checkpoint.

Encrypted, account-scoped local checkpoints pin the initial owner's trusted
signing key and reject later API substitutions, forks or rollback against the
known checkpoint. This does not detect replacement of the entire local
checkpoint with an older authentic filesystem backup. A server can also withhold
new updates; this is not a global freshness or key-transparency service.

The client adapter derives recipients only from a verified directory whose own
entry matches the account's unlocked keys. A directory change cancels in-flight
work. Prepared offline ciphertext is bound to the directory digest and stays
local for review if sharing keys change before a retry. The sharing UI, trusted
invitation exchange, server directory transport and rotation workflow are not
connected yet.

## Encrypted local replica and outbox

`createPrivateWorkspaceReplica` uses account/server/workspace-bound encrypted
storage. The host must hold an inter-window lock across each complete operation.
The replica stores no decrypted cache between calls. Queued intent is copied
before any asynchronous wait and persisted inside encrypted storage.

Before its first network attempt, an edit's exact ciphertext and signatures are
persisted and read back. Restarts and uncertain replies reuse that request.
Only the matching verified journal entry removes it from the outbox. A network
receipt alone is insufficient. Locking or changing account/server invalidates
late work. Concurrent remote changes keep an offline edit for explicit review;
there is no automatic overwrite or silent rebasing.

Limits: 100 upserts and 100 removals per edit, 4 MiB serialized edit input,
200 members, 20 revisions and 8 MiB per feed page, 1,000 queued edits, and a 64 MiB segmented local state. Encrypted 256 KiB
parts stage under a new generation; the active pointer changes only after a
complete reopen and checksum check. Interrupted staging remains tracked for
cleanup. The earlier single-value encrypted format remains readable until its
replacement commits. Each operation captures its unlock generation, so locking
and unlocking cannot resume an old staged save. Backing writes must be atomic;
there is no special power-loss durability claim. A failed local write stops
network submission. Host storage capacity still applies; larger web replicas
need IndexedDB rather than localStorage. No state is silently truncated.

## Remaining rollout dependencies

- A client-verified initial snapshot and migration journal, plus a lossless
  encrypted backup, isolated restore proof and rollback workflow.
- Verified member-key onboarding and rotation, including transactional fencing
  against membership/permission changes and every legacy writer.
- Client CRUD, timers, reports, invoices and import/export adapters, and native
  and extension persistence. Existing clients do not use this replica yet.
- User-facing conflict review/export of unsent work and recovery after local
  storage corruption or loss. New revisions alone cannot settle a conflict.
- Journal/storage quota accounting and retention. Tombstones preserve the old
  ciphertext context; this is not cryptographic erasure of historical journal
  records or ciphertext already copied by another authorized client.

No live data conversion, production backup or deployment is implied by these
internal engines or their synthetic integration tests.
