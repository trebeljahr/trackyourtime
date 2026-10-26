# Private workspace edits

The workspace rollout guard is unconditional. Chained writes and conversion
cannot be enabled with an environment variable. Legacy unsigned/unchained write
and unchecked staging routes have independent refusals. Standard workspaces
and their existing clients keep their current behavior.

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

## History roots and client authority

API level 24 binds snapshot v2 to a common signed initial history root. The root
includes server, workspace, migration ID, verified directory digest and the
complete initial ciphertext digest. Each reader also verifies their own signed
count and projection digest. Other readers' record metadata remains opaque.

Every later edit has a separately signed chain header naming its exact previous
root, writer, operation, expected revision and directory digest. It commits to
the complete manifest digest and the sorted per-reader projection digests. The
canonical header digest becomes the next root; ECDSA signature randomness does
not change it. A valid edit from a different snapshot or alternate branch cannot
continue a locally pinned history. Withholding an entire authentic older
history from a new device remains a freshness limit without a newer trusted
checkpoint or independent transparency/gossip.

Client verification authorizes writes from the signed directory. Entries,
entry money, favorites and imports require self-authorship. Invoice writes need
owner/admin with full time and money visibility. Member-rate writes need the
owner or an admin with money visibility. Other configuration writes require
owner/admin. Business-profile reads retain the existing owner/admin or money-
trusted-member rule, separately from the stricter invoice gate. Audiences must match verified visibility. Where an existing
local record is present, its author must match an upsert or removal. An API
accepting a valid member signature cannot promote that member into a writer
with broader rights. These checks do not prevent an authorized reader from
copying or sharing plaintext outside the app.

The server verifies the full header binding, pins the directory, compares the
previous head and commits the next head with revision, rows and journal in one
transaction. Replay receipts retain their original head after later saves. A
headed workspace refuses legacy signed/unsigned writes and legacy raw-record or
journal reads. Public chained routes remain unconditionally guarded. The old
migration commit has a separate unconditional refusal: opening other routes
cannot enable its source wipe without the new source-proof/cutover protocol.

The replica persists the exact chain header and request before submission. A
receipt alone cannot clear it; the matching chained journal proof must arrive.
Restart and uncertain replies reuse the same request. Bootstrap stores the
signed initial root, and later pulls verify and durably advance it per revision.
After bootstrap, a transport lacking chained history is refused without a
legacy fallback. Headless v1 fixtures remain supported by the library; no live
workspace has been migrated through that earlier scaffold.

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
local for review if sharing keys change before a retry.

API level 22 adds immutable, member-only directory history in bounded pages.
The internal preparation service serializes current members and keys through
the workspace fence and account-key write serials. All members must enroll
keys; signed roles, visibility and both keys must match the current membership.
An exact authenticated retry returns its original receipt. A new owner may
relay the previous owner's pre-signed transfer after roles change; the new
owner cannot self-sign the transition. This service refuses updates once a
migrating or encrypted workspace exists, until atomic regrant support exists.
The public preparation mutation remains behind the unconditional rollout guard.

Settings show a combined encryption/signing verification code from the unlocked
local root, scoped to account and server. The code is safe to compare through an
independent trusted channel. API-advertised keys never supply this code. Lock,
account and server changes clear it and discard late computation. This does not
yet implement member confirmation, trusted invitation exchange or rotation UI.
Identity changes cannot replace public keys used by a prepared directory or a
migrating/encrypted workspace; signed recovery and passkey wrapper changes remain available. New
clients bind enrollment to the intended account and canonical API origin.

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
use the IndexedDB host rather than localStorage. No state is silently truncated.

The client IndexedDB host uses a database scoped by a digest of account and
server, and Web Locks shared across windows. Each workspace operation holds a
shared account lock and an exclusive workspace lock. Only authenticated-storage
envelope shapes can be written through its raw adapter. Writes request strict
browser durability and acknowledge transaction completion, never merely a put
request's success. Capacity, aborted transactions, unsupported/newer layouts and
missing Web Locks fail; there is no memory or localStorage fallback. Browser
storage eviction and hardware failure still require separate backups.

Locking closes the private host without deleting encrypted unsent work; a fresh
unlock reopens it. Confirmed account deletion takes the exclusive account lock,
waits for active workspace operations, invalidates local handles and deletes
only that account/server database. Other windows close on version change, so a
stale host cannot recreate it. A refused deletion preserves local data. A blocked
or failed local cleanup is logged; server deletion cannot be undone and the
account keys have already been forgotten. The host is connected to the private
replica adapters and account cleanup; standard app queries still do not use the
encrypted replica.

## Client migration verification and recovery reconstruction

Initial snapshots have their own owner-signed delivery manifest per reader.
It binds server, workspace, reader, migration ID, revision 1, verified directory
digest, complete projected record count and canonical ciphertext digest. Empty
projections are signed too. Only the reader's own grant is delivered. Other
readers' private IDs and counts are absent from their projection; the migration
owner's preparation input can still include opaque metadata for others' records.

The downloader fixes that signed boundary, accumulates bounded pages, rejects
duplicate IDs, omissions, mixed ciphertext and unauthorized audiences, then
authenticates every delivered record before returning a verified receipt. No
partial download becomes a checkpoint. The complete ciphertext input is limited
to 64 MiB and 400,000 records; each page is limited to 100 records and 4 MiB.
The replica installs revision 1 only into an empty checkpoint with no pending
edits. Repeating the same installation is safe; replacing a later checkpoint or
discarding unsent work is refused. A receipt from an earlier unlock generation
is invalid. Verified segmented storage must acknowledge installation before use.
Ordinary signed changes start at revision 2 after bootstrap.

The internal server preparation engine stores immutable bounded ciphertext
chunks and a separate signed manifest/index for each reader in one workspace
transaction. It checks every reader signature, current directory/permissions,
audience, initial revision, signed count and digest. Exact retries retain their
original receipt even after current records change. Logical page offsets hide
the internal sparse chunk index. Missing chunks fail, and later ordinary edits
cannot rewrite the frozen initial snapshot. Account erasure removes personal
favorites from mixed snapshot chunks and the departing reader's manifests,
including former workspaces; other readers' signed projections remain valid.
Canceling migration removes both snapshot collections. API level 23 introduced
the guarded manifest/page contract; level 24 requires snapshot v2 and chaining. There is
no public mutation that can publish snapshots or bypass conversion checks.

This snapshot storage is not connected to conversion yet. Its delivery signature
does not prove lossless conversion from plaintext; the
separate migration-content proof and independently verified original backup
remain mandatory. It cannot detect a server withholding later changes from a
brand-new device with no newer trusted checkpoint. Chained edit/header
verification now binds later revisions to this root. The cutover controller
still needs to consume the source proof and pin this root and directory before
changing the workspace to encrypted mode.

`createPrivateMigrationProof` compares decrypted staged records directly with
the independently verified source backup. It checks the verified owner and
member directory, audiences, authorship, initial revisions, duplicate IDs,
missing source records, and exact typed EJSON values. Its signed proof binds
the source checksum, directory digest, migration ID and complete ciphertext
checksum. Other members' private favorites can remain opaque; the count is
explicit and their plaintext is not claimed as verified. The proof primitive
is not yet consumed by live migration endpoints.

`createPrivateOwnerMigrationProof` adds a separately scoped owner approval. It
reads the saved `.tytrecovery` file through a caller-supplied destination reader,
authenticates and decrypts it using the purpose-bound backup key, compares every
owner-readable typed original with staged ciphertext, and checks the complete
ciphertext root against a current verified owner snapshot. Its signature binds
the exact reopened file bytes, full ciphertext digest, snapshot root, directory,
source checksum and verified/opaque counts. Locking or a scope change cancels
completion. The file itself and backup key never enter the request.

API level 26 adds guarded `acknowledgeMigrationOwner`. The internal receipt
engine rechecks both the owner-visible source and the complete frozen source
inside the workspace transaction. These are distinct checksums when another
member has favorites; the complete plaintext-source checksum is never returned
to the owner. Both staged rows and immutable chunks must match the signed full
ciphertext digest and the current snapshot root. Retries revalidate the source
before acknowledging the existing receipt. No receipt changes workspace mode,
marks an operational backup verified or deletes original data.

A client signature attests its file check; a server cannot establish possession
of an offline file from a signature alone. An independently encrypted complete
original backup and an isolated exact restoration drill remain separate
requirements. The obsolete `migrationArchive` endpoint has its own unconditional
refusal, so enabling other rollout routes cannot expose other identities'
wrappers or a checksum of their plaintext preferences.

The owner can verify every shared record plus their own favorites. Other
members' favorites require a separate `createPrivateFavoritesMigrationProof`.
It accepts a verified snapshot for that member and a typed, favorites-only
original source. It compares exact original values after decryption, checks
authorship and complete counts, and signs source/ciphertext digests bound to
server, workspace, migration ID, directory and snapshot root. Recipient ownership uses each collection's authoritative field: favorites and
member data use userId, entries/approvals use authorId, import receipts use
userId, and batches/invoices use createdBy. Unrelated legacy author fields are
preserved as data and cannot redirect recipient grants. The receipt contains
no preference IDs or plaintext values. A stale unlock generation or
another account's snapshot cannot produce an acknowledgement.

API level 25 adds guarded source/acknowledgement contracts. The source engine
returns only the authenticated member's original favorites while the workspace
is migrating. It retains BSON types and refuses converted workspaces. The
receipt engine verifies the member's directory key, current snapshot and both
original, staged and frozen-snapshot checksums before recording an idempotent
receipt in the workspace transaction.
Changed data or scope fails without changing originals or workspace mode.
Account deletion removes that user's receipts, including former workspaces;
cancellation removes the migration's receipts. These primitives are not yet
connected to a cutover controller. That controller must require private-subset
verification only for members with favorites or integrations not covered by the owner proof;
zero private records do not need another content check. Plaintext source
checksums and these temporary proof bodies must be deleted or client-encrypted
at cutover with the originals. Retaining unkeyed hashes of low-entropy private
values would permit offline guessing. Public audit commitments may refer to
randomized ciphertext; they must not retain plaintext source digests.

`privateRecordsToRecovery` reconstructs the original fourteen collections by
joining the paired time/money records. It preserves IDs, BSON types, operation
receipts, invoice links and issued XML. Missing, orphaned, overlapping or
unexpected money fields fail instead of producing an incomplete lossless copy.
Mongo string/ObjectId values that collide in the encrypted record namespace
also block conversion. Payload workspace, ID and authorship fields must match
the signed record metadata, including when ciphertext authentication succeeds.
The host must supply a complete owner-readable replica; other users' private
favorites remain outside that owner's recovery copy.

## Legacy write barrier and account erasure

Every quota-backed plaintext model write takes the same workspace transaction
fence as migration, then refuses a migrating or encrypted workspace. Single-row
queries are pinned to the row selected for accounting. Stored webhook envelopes
have their own fence without changing standard quota charges. The global webhook
claimer skips private workspaces. Legacy workspace tRPC and REST requests refuse
private mode; REST returns a retryable 412 so clients can retain queued work.
An outbound webhook already in flight still needs a cutover drain before rollout.
These guards do not make an arbitrary raw Mongo writer safe.

Account deletion keeps encrypted shared work records, including the departing
member's time entries. It deletes solo workspaces, the account's encrypted root
envelopes, passkeys and pending device approvals. Personal favorites are erased
from current ciphertext records and mixed journal bodies, including workspaces
the account left earlier. Other members' separately signed projections remain
verifiable. Standard workspace deletion keeps its existing policy.

Historical public keys, recipient grants and manifest commitments remain where
needed to verify shared records. Deleting an account cannot revoke ciphertext
or keys someone already copied; future access changes require key rotation.
The server cannot sign an ownership transfer or create replacement grants for
owner-only records. A client-approved directory transfer and regrant workflow
must precede enabling encrypted owner departure. The account-scoped deletion preview and confirmation show each applicable
retention policy, wait for a current preview and state that user-owned backup
files remain outside account deletion.

## Preparation cancellation and expiry

Preparation has a bounded lease (currently one hour). Internal staging validates
that the mode is still revision zero, has no history head and has not marked a
backup verified. It captures a source/directory under the workspace transaction
fence, encrypts at most fifty records outside that transaction, then reacquires
the fence and checks the exact preparation ID, lease, source and directory before
publishing. Concurrent retries keep the original stored ciphertext. Frozen
initial snapshots cannot acquire new records through a late staging request.

`discardPrivatePreparation` retires only disposable preparation ciphertext,
reader snapshots, receipts and the preparation mode, in one fenced transaction.
It preserves original collections, user-held files, account keys and public key
history. It refuses converted workspaces and unexpected committed history.
Explicit cancellation still requires the outer controller's owner authorization.

Expired preparations are retired lazily on authenticated standard workspace
access, private workspace status polling or a model write, so offline members cannot keep a workspace frozen
indefinitely. Cleanup during a model write participates in that write's
transaction and rolls back if it fails. No background deletion of user backups
or original records occurs. A pending encryption job cannot resurrect canceled,
expired or replaced preparation. Snapshot creation and content acknowledgements
also refuse expired writable preparations. All public rollout guards remain
closed; the internal stage engine is not a migration entry point.

## Residual plaintext verification

`auditPrivateWorkspaceRetirement` inspects the current database and returns only
collection/reason/count rows. `assertPrivateWorkspaceRetirement` requires an
active cutover transaction with pinned encrypted state and verified-backup
metadata, and must run after its planned source retirement,
before commit. Any finding aborts that transaction. Neither helper deletes
anything or enables conversion; a clean report is not rollout authorization.

The check requires all original business collections except the retained
membership routing table to be empty. This includes entry-operation request
hashes/results. Webhook subscriptions and queued delivery envelopes must also
be absent: URLs and signing secrets need a verified encrypted copy, and active
outbound jobs must drain before retirement. API credential hashes/scopes may
remain as authentication metadata, but labels must be encrypted and cleared.
Temporary migration receipts must retire with plaintext source checksums;
PrivateWorkspace.sourceRevision becomes the explicit non-secret `retired`
marker. Immutable snapshot/journal commitments hash ciphertext and may remain.

Retained membership names and rates must be cleared after their verified
ciphertext copy exists. Authentication organization rows need generic routing
name/slug placeholders and no original logo or metadata; their originals need
an additional encrypted recovery path before this replacement is safe. The
helper produces deterministic opaque routing placeholders without changing any
row. Unknown top-level fields in retained routing/private storage and unknown
workspace-scoped collections fail the check instead of being assumed harmless.

The existing fourteen-collection recovery format does not yet cover organization
identity, webhook configuration, token labels, account preferences, profiles or
avatars. Account data has different ownership/scope and needs its own migration;
the workspace auditor does not claim to verify it. Authentication email,
membership/permission relationships, credential verification data, routing IDs,
record sizes and timing remain server-visible metadata. Global scheduler errors,
application/proxy logs, old dumps, storage pages, oplogs and database snapshots
require a separate operational audit and retirement plan. Logical deletion does
not prove erasure of prior plaintext copies or stop an already-sent webhook.

Catalog enumeration cannot run inside MongoDB transactions. The audit bounds it
to 256 collections, reads catalog metadata outside the transaction, and performs
record checks using the caller's snapshot session. The cutover must fence all
workspace writers and prevent unclassified writers/collection creation through
maintenance controls. All current rollout guards remain closed until the
missing encrypted sources, adapters and operational checks exist.

## Member details and rates

API level 27 adds the `members` encrypted kind. Lossless partitioning separates
an original membership into shared member details (including the display name)
and a `memberMoney` row containing its original ID, hourlyRate and any unknown
legacy fields. Unknown fields retain the earlier restricted audience instead of
becoming visible to all colleagues. Member details accept an explicit field
allowlist; rate/unknown fields cannot be placed there through the crypto helper.
All members can decrypt the details; rate grants retain the existing per-person
money visibility. Names no longer depend on permission to view a colleague's
rate. The signed directory remains the authority for roles and permissions;
clients must not grant access from descriptive membership payload fields.

Recovery reconstruction requires each details/rate pair and preserves exact
EJSON values. Missing or orphaned parts fail instead of producing a partial
backup. The guarded private initial-snapshot capability now requires level 27;
ordinary standard clients keep their existing minimum version. No previously
converted workspaces exist because rollout is still closed. Original v1 typed
recovery files continue to open; their raw membership schema is unchanged.

## Supplemental workspace and integration originals

API level 28 adds `workspaceIdentity` and `integrations` encrypted kinds and
raises the guarded initial-snapshot capability to the expanded kind set. The
typed recovery supplement contains original authentication organization data,
API-token records and webhook subscriptions, including raw BSON, URLs, signing
secrets and unknown legacy fields. It has its own checksum, exact collection
set, workspace binding and bounded size/count. It supplements the existing
fourteen-collection snapshot; it is not a replacement for it.

Known organization identity fields are readable by workspace members. Unknown
legacy organization fields remain in the internal source copy but block ordinary
source reads and publication until their private audience is explicitly defined.
Integration records use
collection-prefixed IDs and the actual creator field (userId for API tokens,
createdBy for webhook subscriptions). Only that creator receives a grant; the
workspace owner gains no exception. Unrelated legacy ownership fields cannot
redirect the ciphertext. The crypto helper checks scope, source ID and creator
before encryption and after decryption. Recovery reconstructs exact original
IDs and typed values; duplicate/colliding addresses or orphaned creators refuse
conversion rather than dropping data or guessing ownership.

The internal normal source reader returns shared organization identity plus
only the caller's own integrations. `capturePrivateMigrationSupplement` is a
separately named server-side complete-source engine, restricted to the current
owner-controlled migration; its output must never be returned from a user API.
It encrypts others' originals to their keys during staging. Neither reader is
mounted as a public endpoint, and both refuse an already encrypted workspace.

Account erasure treats integrations like favorites, removing the departing
creator's ciphertext from current records and mixed initial snapshots/journals,
while retaining shared work and the immutable commitments needed to verify
other readers' projections. It does not delete another creator's integrations.

The combined v2 user-held backup includes both typed datasets, scoped to the
owner's readable originals. Its authenticated format cannot downgrade to v1.
An isolated restore drill verifies all seventeen collections and both checksums;
it is not the complete operational backup required for retirement. Existing v1
backups still cover only fourteen collections, and the older migration proof
cannot approve supplemental records. Public combined migration flow, per-creator
content receipts and a complete operational restore proof remain required before
this source can authorize any retirement. Profile/avatar/user-preference encryption
still needs an account-scoped path. Server-side webhook/REST behavior in private
mode also requires explicit compatibility handling; copying configuration does
not make a blind server able to deliver plaintext events.

## Combined owner approval (internal)

`createPrivateCombinedOwnerMigrationProof` requires a branded verified reader
snapshot and reopens the actual saved v2 encrypted file. It compares both exact
typed datasets to decrypted owner-readable records, checks every grant against
the verified directory and binds the signed v2 receipt to the complete snapshot
root, full ciphertext digest and exact encrypted file bytes. Other creators'
favorites/integrations stay opaque; this approval never claims their plaintext
was checked. Missing, changed, duplicated or tombstoned records refuse approval.
Generation invalidation after I/O or crypto prevents a late signature.

The internal server receipt path checks both owner-readable source checksums
and the complete frozen source checksums inside the workspace transaction fence.
It verifies current owner/directory/signature, original addresses/authorship,
recipient sets, materialized ciphertext, immutable chunks, reader manifest/root
and counts before recording an idempotent temporary receipt. Replays recheck
source and ciphertext. The complete supplement checksum stays server-side.
An optional preparation `supplementRevision` binds supplemental staging before
and after encryption; lossless aggregate source limits still apply. Its
plaintext-derived checksum must be removed or set to `retired` at conversion;
the residual audit rejects it otherwise. v1 receipts cannot approve a workspace
that contains supplemental originals, even if a marker was not created.

No v2 source/receipt/begin controller is mounted publicly. Existing begin flow
still prepares only v1 and remains guarded. A receipt does not change mode,
set operational backup verification or delete originals. Per-creator content
receipts, preflight before the v2 begin controller, complete operational backup and
isolated restoration, app adapters and atomic source retirement remain required.

## Personal subset approval (internal)

A member's v2 encrypted container may contain a favorites-only business source
and an integrations-only supplement. Organization and all other shared source
collections must be empty. The account/server/workspace-bound file key belongs
to that member; the `ownerId` archive field identifies the file's account, not
a workspace role. The offline opener remains compatible with this container.

`createPrivatePersonalMigrationProof` reopens the saved file, verifies exact
source checksums and typed content against only the member's branded snapshot
projection, and signs its root, private ciphertext digest and file commitment.
It never requires complete workspace ciphertext or other creators' private IDs.
The server-internal source reader returns only the caller's favorites and
integrations during an active v2 preparation. The internal acknowledgement checks
membership, directory/signature, current snapshot root, originals, addresses,
single-creator grants, staged ciphertext and frozen chunks before storing an
idempotent `personal` receipt. Replays repeat those checks. Account deletion and
preparation cancellation remove these receipts with the existing scoped cleanup.

These preparation source/proof functions are not mounted publicly. The trusted-root
challenge boundary must authorize them when mounted. API 30 separately exposes
owner-readable combined backups only for entirely standard workspaces; it cannot
read preparation/private originals or activate migration. See `private-backups.md`.
The cutover controller must require personal receipts only for non-owner members
with private originals; no records means no content approval to wait for. Neither
a personal nor owner receipt replaces complete operational restoration or permits
source deletion. All plaintext checksums and temporary receipts must retire.

## Encrypted storage accounting

The shared workspace/account quota ledger now includes materialized encrypted
records, immutable journal and snapshot copies, reader indexes, public directory
history, temporary content receipts and workspace mode rows. Recipient grants
count at their full stored BSON size. Every row retains the ordinary 4 KiB
record/index floor. Ledger version 3 rebaselines existing data before the next
accounted mutation; old version 1 totals cannot hide pre-existing private bytes.

These private models use the same transactional workspace/account storage fences
and before-commit growth checks. They skip only the plaintext-mode guard;
private service authorization and workspace fences remain required. Ordinary
models still refuse writes during preparation/private mode. Snapshot duplication,
large grant sets and concurrent writes across owned workspaces cannot escape
the account allowance. Refused batches roll back all ciphertext/ledger writes;
shrinking and deletion remain possible over budget. Preparation expiry and
account erasure retain their existing scoped cleanup behavior.

This is logical application storage, not physical disk usage or accounting for
account-key envelopes, auth records, organization uploads, database indexes,
logs/oplogs and external backups. Raw native collection writes require explicit
maintenance accounting. Signed checkpoint/retention design and durable migration headroom reservations
remain unfinished; this accounting change does not enable public migration.

## Migration sizing and current headroom

Before the first staging batch encrypts a record, a conservative estimator checks
UTF-8 JSON payload sizes, GCM tags/base64url expansion, every authorized recipient
envelope, individual record/page bounds and the complete 64 MiB snapshot bound.
It estimates materialized BSON (including the 4 KiB floor), immutable snapshot
copies, a worst-case chunk count and reader/temporary-receipt/mode overhead.
Opaque originals are sized internally without returning values or source hashes.
The estimate is not a source-content or restoration proof.

The headroom check recounts actual registered collections across the current
workspace and its owners' other workspaces under the shared account storage
fences. It does not trust cached ledgers when legacy/native maintenance may
have bypassed accounting. Insufficient temporary capacity rejects before record
encryption; original rows stay intact. Existing staged batches still face the
actual transactional limits on each later write.

This check does not reserve capacity between transactions. Concurrent later work
can consume space and require cancellation/retry; conservative estimates can
refuse work near the bound even if a tighter packing might fit. The future v2
begin controller must run the same preflight before creating its mode/lease.
Maintenance/raw-writer fencing, a durable reservation policy and retention still
need completion before public conversion is enabled.

## Session-bound original-read authorization (internal)

A source read needs a one-use signed challenge in addition to the authenticated
login. The challenge binds canonical server origin, account, workspace, source
purpose, current preparation ID (or null before owner preparation), a digest of
the current session ID and both unlocked account keys' fingerprint. It contains
no session token, private key, original value or plaintext source checksum.
The signer checks expected operation/session/root, bounded two-minute lifetime
and unlock generation before signing. Expired or substituted scopes are refused.

The server issues at most three outstanding challenges per account using the
account-key transaction fence. Consumption repeats live role/mode, scope/session,
root fingerprint, stored challenge and expiry checks, verifies the root signature
and deletes the nonce in the same fenced transaction as the source read.
Concurrent replays can release originals only once. Owner source reads still
exclude other creators' private records; personal source reads contain only the
caller's favorites/integrations. Converted workspaces refuse original reads.

Challenges are bounded transient control metadata with a TTL, separate from the
content quota so a full account can still request recovery originals. Cancellation
removes workspace challenges; account deletion removes the person's challenges
across workspaces. Key changes, role loss, another login session and source mode
changes invalidate pending authorization. Authentication context must supply
server/user/session/workspace scope when the future router mounts these engines;
no challenge/source endpoint is public in this build. A fresh login/password
reset alone cannot produce the existing account root signature.

## Record key binding (API level 29)

New records include `keyCommitment`, a domain-separated SHA-256 commitment to
the random 256-bit record key and workspace/kind/ID/author/revision context.
The commitment enters the v2 authenticated-encryption context for both content
and recipient envelopes. Each reader checks its unwrapped key against the same
commitment before decrypting content. Signed record hashes, immutable snapshots
and history include that field; materialized storage and projections preserve it.
Migration footprint estimates include the extra bytes.

AES-GCM alone is not key-committing; multi-reader wrapping must not assume it
proves that different recipient envelopes contain one key. See the primary
[USENIX analysis of authenticated encryption without key commitment](https://www.usenix.org/conference/usenixsecurity22/presentation/albertini).
This application binding uses random record keys, not password/plaintext
checksums. It does not substitute for signature, source-content or audience
verification, or claim a general password-encryption fix.

Authenticated legacy record reading retains its original v1 context. Removing
or replacing a new commitment cannot downgrade a v2 ciphertext because its
content/envelope authentication then fails. New initial snapshots and new
signed journal writes refuse missing commitments; old immutable operation replay
is retained. Initial-snapshot capability now requires API 29. Standard minimum
client level remains 1; workspace rollout remains closed. Complete migration
proof/delivery and private app adapter dependencies below still apply.

## Separated initial projections (internal v3 primitive)

The new core-only initial root signs two ciphertext digests per verified reader:
a shared projection and a personal projection. The owner receives every shared
record with its full authorized grants, plus only the owner's personal records.
The signer validates all shared audiences and decryptability, then computes each
shared-reader digest locally. It accepts opaque personal digests for other
creators only; it refuses exposed foreign personal records. The root contains
membership and opaque digests, not other creators' personal record IDs/counts.
An empty personal digest can still indicate that no personal records exist.

Every reader verifies the owner signature, directory/scope, exact independent
shared/personal digests, record namespaces/audiences, committed keys and decrypted
payload bindings. Truncated/substituted shared data cannot hide under an opaque
personal digest. Validated results are frozen and branded to distinguish them
from unverified persisted/network objects; unlock invalidation revokes their use.
This primitive authenticates initial content, not global freshness after every
device/checkpoint is lost. Durable mode/root pins remain required.

Internal v3 storage, reader delivery, receipts and replica bootstrap now exist.
Public activation/transport controllers remain unmounted. Source correctness
still needs reopened original-backup proofs; owner signatures alone cannot
authorize retirement. Initial conversion uses the separately signed exact-source
worker below. Legacy raw/unsigned and unchecked staging routes stay refused.

## Saved-file proofs for separated projections (internal)

The new owner v3 content proof reopens a saved combined v2 file, compares both
exact typed original datasets to the owner's branded shared/personal projections
and signs their common root, own ciphertext digest, both own source checksums
and exact encrypted file bytes. No complete opaque record archive, foreign
personal IDs or foreign record counts are passed to this helper. The personal
v2 proof similarly checks only that creator's favorites/integrations and refuses
shared originals in a personal file. Both enforce current unlock/provenance,
account/server/workspace binding and separate copies of caller-owned purpose keys.

These statements are distinct from older v2 owner/v1 personal receipt protocols;
no public server endpoint accepts them yet; internal v3 receipt verification is described below. Their temporary plaintext-derived
source checksums must retire at cutover. Personal approval does not claim to
validate all of a member's shared originals. Client-side staging must preserve
existing actor/business rights and obtain any additional required source/content
attestations; the owner root alone cannot create authority to edit peers' work.
Neither proof replaces complete operational backup/restore or permits deletion.

## Bounded owner proposal (internal)

`privateProjectionProposal` captures a complete staged set under the workspace
transaction fence, checks active v2-source preparation, current directory roles
and both public account keys, frozen complete-source checksums, exact original
addresses/authorship, audiences, revision and key commitments, and size/count
bounds. It refuses incomplete or changed staging before returning a proposal.

The owner response contains shared ciphertext with full authorized grants, only
the owner's personal ciphertext, and per-reader opaque personal digests. Complete
source checksums, other identities' recovery wrappers, foreign personal IDs and
exact personal counts never enter that response. The separately named complete
capture engine is server-internal only and must not be returned from a user API.
The proposal does not freeze or publish a root. It is a transaction snapshot;
the later storage/receipt controller must recheck state before accepting it.

## Immutable projection storage and delivery (internal)

`preparePrivateProjectionSnapshot` rechecks the complete fenced preparation and
owner signature, recomputes every reader's two ciphertext digests, then stores one
signed v3 root, bounded immutable chunks and separate shared/personal indexes.
Retries compare the complete frozen chunks and reader indexes; mixed protocols,
partial storage and changed roots refuse publication. The v2 helper likewise
refuses a prepared v3 root, including an empty snapshot. Preparation does not
activate encryption, approve backups or delete originals.

Internal root/page reads require current membership, matching server/preparation,
a live lease before cutover and a consistent encrypted-mode head afterwards.
They use the account-erasure workspace fence. Independent shared/personal pages
return only the caller's grants and logical offsets, not foreign personal IDs,
counts or physical indexes. Each result still needs client signature/content
verification. Frozen initial records survive later materialized edits.

Cancellation/expiry and solo workspace deletion remove both new collections.
Shared account deletion removes only that account's reader index and personal
ciphertext; the common root and other readers' projections remain verifiable.
Quota ledger version 3 includes the root and reader indexes. No public v3 route,
live activation is enabled by these internal helpers.

## Separated-projection receipts (internal)

The new owner v3/personal v2 receipt handlers accept only their distinct schemas.
They require current scope/membership and active preparation, then recapture the
complete source, current account keys/directory, every frozen chunk/index and the
owner-signed common root under the same workspace transaction fence. This full
capture stays internal; a member receives no other creator's originals or IDs.
The owner proof binds the owner's shared/personal reader projection; a personal
proof binds only that creator's private projection. Each is checked against its
own typed source checksums, record count and exact reader ciphertext digest.
Even byte-identical receipt replay repeats every validation.

The common receipt collection preserves the explicit proof version; old receipt
handlers reject the new schemas. A receipt never sets `backupVerified`, changes
mode or deletes source data. It attests the client's reopened saved-file/content
check; complete independent operational backup/isolated restoration, additional
shared-source attestations and the cutover controller remain separate obligations.

## Verified v3 download and encrypted replica bootstrap

`loadPrivateInitialProjection` requires an expected common root supplied from
trusted activation/device/recovery state. The same untrusted response must not
choose that root. It authenticates scope/directory/owner signature before any
record pages, then independently downloads shared/personal pages with strict
progress, count, size and unlock-generation limits. Both complete ciphertext
lists, audiences and decrypted record bindings must verify before it returns a
branded snapshot. Partial or mixed downloads are never persisted.

`bootstrapProjection` accepts only that current branded snapshot for the same
account/server/workspace/directory. It installs the common root and both sorted
ciphertext lists into the segmented encrypted replica with confirmed writes.
It preserves pending work and refuses to replace an existing checkpoint; exact
initial retries are idempotent. Subsequent edits extend the root using the same
signed chained history/outbox path. A headed checkpoint refuses legacy history.
The client wrapper binds downloads to the live private session and API origin.

This is a delivery/bootstrap adapter, not a public activation UI or a durable
mode-pin policy. Trusted initial-root provisioning, full app adapters, safe
new-device policy and operational migration/rollback remain required.

## Signed client-preparation lease (internal)

A separate preparation intent signs the owner's readable combined-source
checksums, verified directory, current login-session digest, fresh migration ID
and two-minute lifetime. Reading a backup cannot create this intent. The
internal begin engine authenticates the owner/signature/scope, checks current
public keys/roles and the stored directory's signature/digest, captures complete
originals internally and compares the owner's signed subset. It refuses running
timers, aggregate backup limits, orphaned private artifacts and insufficient
temporary storage before creating any lease. The result contains only the ID,
directory digest and one-hour lease deadline, never peers' source checksums.

Workspace/account transaction fences make concurrent retries idempotent. The
request ID is consumed atomically with the lease; replay never extends its
lifetime. Cancellation keeps a bounded nonce record until the signed request
expires, so a delayed start cannot recreate canceled preparation. At most three
live intents per account are retained; TTL is backed by explicit expiry checks.
This bounded authentication metadata is separate from content quota accounting.
Account/workspace erasure removes it, and the residual audit requires retirement
of these source-bound request digests at cutover.

New leases are marked `client-v2` and pin the directory. They refuse the legacy
server-encryption stager. The source/chunk/proposal verifier reuses the same
current-directory checks. No public begin endpoint or staging controller
is mounted. Source originals, workspace revision/head and backup verification
remain unchanged. Preflight checks availability; it does not reserve headroom.
Device/old-client readiness, the exact-original staging worker below,
complete operational restoration, cutover and app adapters remain required.

## Exact-original conversion worker (internal)

Read access does not grant permission to rewrite another member's work.
Accepting arbitrary replacement ciphertext from the workspace owner would lose
that distinction unless additional proofs/authorities were required. Existing
plaintext conversion therefore accepts only a separate signed owner intent;
it accepts no record values, replacement ciphertext or caller-selected offsets.
The worker encrypts the exact frozen typed originals already held by the server,
including creator-only records directly to their verified recipients. The owner
still receives only authorized shared/own records and opaque personal digests.

`client-v2` marks client-authorized preparation, not client-generated keys for
historical plaintext. This is a transitional trust boundary: the existing server
already knows the originals and briefly generates record keys for their initial
conversion. No account private key is given to it. Blind-data protection can
start only after file/content/operational verification and retirement of the old
server process, active plaintext storage and retained copies. Clearing JavaScript
arrays or deleting documents is insufficient. New private edits stay encrypted
on devices with independent random record keys. No public worker or activation
route is mounted, so this internal engine cannot bypass those obligations.

The signed intent binds current session, scope, preparation, directory and a
two-minute start window. The one-hour preparation lease bounds subsequent work.
A durable internal cursor advances in the same transaction as each bounded
ciphertext batch. Lost acknowledgements/concurrent workers preserve the first
accepted ciphertext and never move the cursor backward. A failed progress save
rolls back its batch. Mode identity prevents a late batch from publishing into a
replacement lease even if its migration ID was reused. Cancellation, expiry,
changed source or changed current keys prevent publication. Directory validation
fences every participating account-key row, including signing keys.

Only coarse queued/working/complete status leaves the job helpers. Internal
cursors/counts must never be surfaced by an owner API. Complete retries recheck
the full staged source. Temporary staging authorization must retire at cutover.
This is not a background scheduler/controller, a content receipt or an
operational restore proof. Legacy staging wrappers remain independently refused.

## Preparation content readiness (internal)

The preparation controller can now revalidate content readiness against the
owner's verified initial-root checkpoint. It accepts only the signed
`client-v2` exact-original worker, requires completed progress equal to the
complete staged set, and verifies the immutable root, chunks and all reader
indexes against current originals and member keys in one fenced transaction.
It then verifies the stored owner saved-file receipt and a personal saved-file
receipt from every other member who has opaque personal originals. A member
with no such originals needs no separate personal-data acknowledgement.

Stored receipt presence is insufficient: protocol, signature, scope, directory,
root, source checksums and projected ciphertext/count are rechecked. The full
ciphertext set is captured once rather than rescanned for each member. Polling
returns only `awaiting-verification` or `content-verified`, without missing-user
lists, private record counts, source checksums or file details. Invalid/stale
state refuses verification. No public route or mode transition is enabled.

This status is neither an operational backup/restore proof nor permission to
retire source records. A future cutover must repeat verification inside its own
transaction and satisfy independent operational backup, rollback, device-policy
and storage/process retirement requirements. Account erasure cancels pending
preparation atomically with its guarded write; encrypted shared modes retain
their ciphertext and verification history.

## Operator originals and isolated restore tooling (internal)

An operator-only archive now captures all seventeen original collections from
the frozen preparation, including every creator's favorites and integration
originals. It requires current content readiness and binds the exact preparation
row, migration, directory and signed initial root. This format is deliberately
separate from owner/member files, which exclude peers' private originals. It
has no user API and must never be returned through one.

On the trusted operator machine, an independent random 256-bit key derives an
HKDF-SHA256 purpose key bound to that checkpoint. AES-256-GCM authenticates the
distinct file header and complete typed archive. No account password or private
root participates. The library never saves or returns the operator key; keeping
it independently off the application host remains an operational requirement.

The writer exclusively creates a new 0600 file, syncs it, reopens the saved
bytes and compares/decrypts them. It then starts its own temporary authenticated
MongoDB process to restore and reread every typed document. It accepts a local
`mongod` executable, not an arbitrary restore database connection. A socket in a
0700 directory prevents a loopback-port race from redirecting bootstrap commands;
the authenticated process must report the expected private data path. Restored
document digests must equal both full-source checksums. Successful return binds
the checkpoint and encrypted file SHA-256. Existing files are never overwritten;
failure returns no verification result and preserves encrypted file evidence.
The throwaway process/database/directory are cleaned on success and failure.

This is a bounded workspace-originals drill, not a complete installation backup
or an activation authorization. Indexes, auth/account tables, external files,
backup key custody, post-cutover work/rollback and operational attestation still
need integration. The drill necessarily creates transient plaintext on the
trusted operator machine; removing temporary files does not prove physical
storage erasure. Operator storage/copies join the required retirement inventory.
No customer archive, live restore, cutover or server-side backup approval has
been performed by these synthetic checks.

The saved-file result now has a process-local, frozen verification brand. An
independent operator signing key can attest only a fresh branded result, not a
JSON report or caller-provided success flag. Existing files can be reopened and
drilled again after restart without rewriting them. The signed, one-hour proof
binds both complete-source digests, the encrypted file SHA-256, exact checkpoint,
operator fingerprint and verification time. Neither the backup key nor signing
private key is saved by this library.

An internal recorder verifies against an independently pinned operator public
key supplied by operational policy, never by the submitted request or workspace
owner's account identity. It repeats current content/source verification in the
workspace transaction before storing the proof. Exact replay rechecks current
data; renewal requires a newer verification by the same pinned operator. Older
proofs cannot replace newer ones. Future cutover can revalidate the stored proof
inside its own transaction; expiry/lease checks also run before commit. No mode
or `backupVerified` flag changes. The source-bound proof is temporary migration
metadata and must retire at cutover, as enforced by the residual audit. Operator
key provisioning/rotation, the operational controller and complete installation
rollback remain unimplemented; this code supplies no network bypass.

## Device workspace-mode pins (adapter foundation)

A device can now sign an encrypted-workspace policy only from a current,
fully verified initial projection and directory matching its unlocked account
keys. The pin binds account/server/workspace, the initial root and directory,
and the initial owner's public signing key/revision. Its account signature
allows verification after trusted device/recovery transfer without trusting a
new API response to select the initial checkpoint.

The durable store authenticates/encrypts the pin under scoped account storage,
reopens writes and keeps the first accepted activation. There is no downgrade
or remove API. Missing, locked, corrupt or differently scoped policy refuses
selection of a data adapter. A verified pin refuses an omitted, standard or
preparing API mode. The client wrapper binds every operation and returned pin
to the current account unlock generation and server. Locking invalidates old
handles and pins even after unlocking the same account again.

The expected root/directory must come from verified activation or trusted
device/recovery state; accepting those values from the same server response
would defeat the check. A new device without that trusted state requires a
separate enrollment decision. Complete local filesystem rollback is also not
detected by this store alone. It is not a complete signed account inventory,
sharing/rotation workflow or old-client retirement mechanism. Existing client
tabs may transmit their old plaintext queues before any server refusal. The
future activation controller must preserve those queues and establish client
readiness before conversion. App-wide routing, cache teardown and all private
CRUD/timer/report adapters still need integration. Existing standard behavior
is unchanged and no workspace activation route is enabled.

## Signed account workspace inventory (adapter foundation)

The account now has a versioned signed inventory of explicit standard entries
and encrypted workspace pins. It contains no workspace names or content. An
unknown workspace is a trust/enrollment decision; it never defaults to standard.
Each encrypted entry retains its account-signed initial policy, verified against
the same account/server/workspace. Consecutive revisions bind the prior digest.
Private entries cannot disappear, downgrade or replace their initial pin, even
after membership ends. Standard entries may be updated or removed normally.
Ordinary updates cannot rotate the account signing key.

Its encrypted local store requires an account-wide lock shared by workspace
windows, verifies persisted writes and rechecks signatures when loading. It
distinguishes three operations: explicit fresh in-process local enrollment,
consecutive server/history update, and new-device restoration against an exact
checkpoint obtained independently from device/recovery. A server replay of an
old signed initial inventory cannot enroll a device automatically. Enrollment
results expire with their signing session; lock/unlock cannot revive one. A
restore cannot replace newer local state. Missing, corrupt or locked inventory
is an error. The inventory is bounded by 1000 entries/512 KiB and refuses excess
without truncation.

The client adapters and account-wide durable host bind this state to the current
account/server/unlock generation. This remains a local library foundation:
API 31 supplies ciphertext history below, but profile/device/recovery transfer,
initial enrollment UI, active data routing and the conversion controller remain. A new
device without an independently trusted checkpoint still needs an explicit
decision. Callers must never start fresh enrollment automatically after stored
or server metadata disappears. A complete local filesystem rollback or a stale
recovery checkpoint cannot prove that the server has no newer history. Old-client
retirement, preservation of unsent work, and private CRUD/timer/report adapters
remain mandatory before conversion can be enabled.

## Encrypted account inventory versions (internal protocol)

The portable transport primitive now encrypts a current verified account
inventory under an account/server-bound HKDF-SHA256 purpose key derived from the
unlocked random master secret. AES-256-GCM authenticates a strict header with
revision, operation ID, previous ciphertext root and signing-key fingerprint.
The account's ECDSA signature binds that header and ciphertext, allowing a blind
server to authenticate/sequentially store it without the master secret.

The ciphertext root commits to the header/box rather than ECDSA signature bytes,
so a different valid signature of identical content does not fork its checkpoint.
Operation intent, key material and checkpoints are captured before awaits;
account/session changes discard late work. Bounds cover the complete signed
inventory and encrypted version. The exact envelope must be saved durably before
submission; retry must reuse it.

Delivery verifies the public signature and exact preceding scope/key/root/revision
before decrypting, then checks the inner inventory signature and matching revision.
It returns an unbranded signed document. Only the account inventory store can
accept it through consecutive local history or independently anchored restoration;
it cannot enroll an empty device merely because an API supplied valid ciphertext.
API 31 now uses this primitive for the account-only endpoints below. A durable
client transport outbox is still required. Workspace rollout remains disabled.

## Account erasure versus delayed private writes

A confirmed account deletion now commits a one-way account erasure fence before
its data cascade. Its key is a domain-separated SHA-256 commitment to the random
account ID. The retained row contains only that commitment, an erasure flag and
concurrency counter: no email, key material or ciphertext. A new account using
the same email gets a different ID and is unaffected.

Private account mutations hold the same fence in their MongoDB transaction. A
writer already holding it finishes before deletion marks the account and its
result is swept by cleanup. A delayed/stale transaction retries against the
erased marker and refuses instead of recreating keys after cleanup. Marker
creation/mutation rolls back with failed private requests; erasure never resets
on retry and the marker survives both account cleanup passes. The private-device
request service also holds the fence when called directly. Standard deletion
can set its single-document marker on standalone MongoDB; private mutations
require a replica set. Password/fresh-session validation happens before marking.

This closes the encryption-key enrollment retry race and protects future
inventory mutations; it is not erasure of content/keys already copied by a
formerly authorized device, a physical-storage wipe, or an old-client plaintext
transport policy. Queries and existing standard account behavior retain their
existing rules. No live account has been marked by the synthetic regression
checks.

## Account inventory persistence and API 31

`privacy.inventoryWrite` and `privacy.inventoryVersions` now store and deliver
only account-owned signed ciphertext under the `privacy.accountInventory`
capability. Both use authenticated POSTs and `Cache-Control: no-store`. Account
and origin come from the authenticated context/configuration, never a submitted
workspace/user selector. They require the enrolled account's signing key and
the account-erasure transaction fence. Workspace conversion stays disabled and
the minimum API level for existing standard clients remains 1.

The account head, immutable revision and charged metadata bytes commit together.
Retries preserve the first accepted ciphertext/signature, including after later
versions; a different valid signature over identical header/box keeps the same
opaque root. Reusing an operation ID for different ciphertext refuses. Concurrent
writers serialize against the account row. Failed head publication rolls back
its ciphertext, and stale revision/root conflicts keep the pending version.

History is bounded by 4096 versions and a separate 32 MiB account-metadata
budget, conservatively charged for full BSON plus overhead. Counters are checked
against the actual immutable rows and head; missing history/corrupt stored
signatures refuse rather than acknowledging a vanished version or inventing an
empty account. Four-version pages pin their requested high-water boundary even
when later writes arrive. The server never receives the master or plaintext
inventory and never interprets encrypted mode classifications.

Existing key rows without inventory metadata adopt revision zero only while
history is empty, then get metadata atomically on the first write. Orphaned
encrypted history prevents fresh root enrollment; existing history prevents
unsigned/unverified key rotation while still allowing same-key wrapper changes.
Account deletion removes all private inventory versions before key cleanup, and
the retained erasure fence blocks delayed re-creation. There is no silent history
truncation or quota fallback.

This is account metadata transport, not device readiness, initial enrollment UI,
trusted recovery transfer or private content routing.
Old/offline-client retirement, actual private CRUD/timers/reports, full backup
and rollback, storage retirement and the conversion controller remain required.

## Durable account inventory sync

The core sync engine atomically publishes one encrypted, segmented state holding
the local profile, confirmed ciphertext checkpoint and exact pending envelopes.
It saves and reopens the complete state before any send. Up to eight pending
versions are retained without truncation. Failed staging leaves the prior active
generation readable. Hosts must hold the account-wide lock for each operation.
Intent and unlock scope are captured before waiting for that lock.

A matching commit response alone cannot remove pending work. The client fetches
and authenticates the consecutive ciphertext feed through that exact revision,
decrypts and verifies the inner profile transition, then atomically publishes the
confirmed checkpoint with the remaining queue. Lost responses reuse the original
operation ID, nonce, ciphertext and signature after restart. Four-version pages
pin a high-water boundary. A competing signed revision or invalid inner transition
is saved as a conflict alongside remaining pending ciphertext. Reads, writes and
flushes then refuse until explicit review; encrypted export remains available.
There is no automatic conflict discard or resolution.

First enrollment requires a current locally signed revision-one profile. A new
device restores only against independently trusted exact profile and ciphertext
checkpoints. Missing or stale server data cannot enroll a device or select standard
storage. Existing local-only profile files refuse automatic import or replacement;
there is no two-file profile/outbox update path.

The client adapter uses strict IndexedDB and the account-wide Web Lock. Locking
closes its host without deleting pending work. Persistent verified-value checks
retain a session epoch rather than private account keys. Its dedicated transport
uses fixed-origin, non-batched POSTs, ordinary authenticated cookies or native
bearer credentials, no-store caching and redirect refusal. It checks scope and
confirmed API 31 support again after native readiness at actual dispatch; an
unknown/older server cannot trigger optimistic or plaintext fallback. This
infrastructure is not mounted in active content routing or a conversion UI.

## Remaining rollout dependencies

- A source-verified migration controller that publishes the separated initial root, consumes
  per-member verification for opaque records and pins root/directory at cutover,
  plus a lossless encrypted backup, isolated restore proof and rollback workflow.
- Verified member-key onboarding and rotation, including transactional fencing
  against membership/permission changes and every legacy writer.
- Client CRUD, timers, reports, invoices and import/export adapters, and native
  and extension persistence. Existing clients do not use this replica yet.
- User-facing conflict review/export of unsent work and recovery after local
  storage corruption or loss. New revisions alone cannot settle a conflict.
- Connect the signed account inventory and device mode-pin adapters to trusted
  profile/device/recovery transport and every content/queue path. Missing keys,
  omitted metadata or an older API must never silently select plaintext adapters.
- Complete client business-transition validation, including approval submissions
  versus reviews, invoice links on colleagues' entries and issued-document
  immutability. Coarse record-kind rights alone do not encode those rules.
- Audit legacy integration secrets/configuration and every unlisted plaintext
  collection. The fourteen-collection business backup does not cover auth or
  webhook credential storage.
- Durable migration-headroom reservations and journal retention. Begin now checks
  availability before leasing, without reserving capacity. Tombstones preserve the old
  ciphertext context; this is not cryptographic erasure of historical journal
  records or ciphertext already copied by another authorized client.

No live data conversion, production backup or deployment is implied by these
internal engines or their synthetic integration tests.


## Obsolete network protocol refusal

Legacy begin/server-staging and unsigned/unchained write routes now call a
separate unconditional refusal before the general rollout guard. Opening a
future verified controller cannot enable these old paths accidentally. Existing
complete-archive and unverified retirement routes retain their independent
refusals. Internal staging remains available only for bounded synthetic checks
and the transitional source engine; it is not a new network API.
