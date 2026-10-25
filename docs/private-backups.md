# User-side recovery backups

The existing password-protected `.tytbackup` download remains available. The
`.tytrecovery` format adds recurring folder backups and offline recovery using
the user's existing random 256-bit recovery secret. This does not enable synced
workspace encryption; that rollout remains unconditionally disabled.

## Encryption and recovery

Setup verifies that the entered recovery secret opens the current account's
identity, including its master, encryption and signing keys. HKDF-SHA256 derives
a purpose/account/server-bound backup key. Only this derived key is cached,
inside the account/server/workspace-authenticated encrypted IndexedDB store.
The full recovery secret is never a stored setting or an API parameter.

Each file contains an AES-256-GCM box and an authenticated header with its
format, server origin, user/workspace IDs and creation time. Record content,
original IDs, typed BSON representations, invoice XML and links are encrypted.
The file does not require private identity envelopes, credential IDs or server
access to reopen. Its recovery secret and the file alone suffice. Password
reset cannot recover a missing encryption/recovery secret.

The signed-in data panel and `/open-backup` both open this format locally. The
public page also opens earlier password-protected `.tytbackup` exports.
Opening does not download plaintext automatically. A separate explicit action
saves decrypted recovery JSON; server restoration remains a separate unfinished
workflow. The public page is available without login and can decrypt after
loading even when the browser is offline.

## Combined original files

The separate authenticated `trackyourtime-recovery-key-backup-v2` header opens
an encrypted `trackyourtime-workspace-recovery-v2` archive. It contains the
fourteen-collection typed snapshot plus a three-collection supplement:
organization identity, the owner's API tokens and the owner's webhook settings.
Other creators' integrations and favorites are refused. Both datasets share one
server/account/workspace scope and aggregate 23 MiB / 200,000-record limits.
Checksums and integration secrets remain inside ciphertext. The outer header
is authenticated; relabeling a combined file as v1 cannot discard its supplement.

The offline opener and password-file opener recognize the combined payload and
warn that a requested JSON export contains unencrypted integration secrets.
Older files remain readable. A server-internal builder captures both datasets
in one transaction. The session/root-authorized standard-workspace endpoints
and recurring v2 scheduler are described below. The internal combined owner proof
reopens the actual saved file before signing a snapshot-bound approval. Public
migration flow and per-creator verification remain separate unfinished work.

The isolated combined restore checker writes and reads all seventeen typed
collections in one fresh disposable database, compares both checksums and drops
the copy. Source reads and reconstruction use MongoDB simple collation: strings
sort by UTF-8 bytes before ObjectIds. This preserves exact mixed BSON ID order.
A typed value that normalizes during database insertion fails verification.
This user-held file excludes other creators' private originals and is not a
complete installation backup or an operational rollback proof.

## Scheduling and file permissions

An owner explicitly chooses a writable directory and a daily or weekly interval.
The scheduler runs only while the app is open, this workspace is active and
private keys are unlocked. It queries permission without requesting it. Missing
permission pauses the job and reports the state in Settings; it never opens an
OS dialog automatically. Unsupported hosts retain manual encrypted downloads.
There is no OS background service or guarantee while the app is closed.

The folder adapter uses File System Access API handles, stored through
IndexedDB structured cloning in a separate account/server-scoped capabilities
database. That database contains handles and routing IDs, not data or keys.
Browser permission persistence and storage eviction still apply. External folder
selection must be a user gesture; tests use a sandbox directory instead of an
OS picker or a personal folder.

Every operation uses the same shared account lock and exclusive workspace lock
as the private replica. A new destination handle stages under a fresh ID before
its encrypted configuration commits. If acknowledgement is cancelled after a
possible config commit, both old/new handles stay available so either persisted
pointer can reopen. Interrupted setup may retain an extra handle until account
cleanup; it does not expose a backup key or record content.

A job verifies its source snapshot, encrypts it, writes a fresh timestamp/UUID
filename, then reopens and verifies the file before saving its success time.
Only its failed new file may be removed during cleanup. Existing backups are
kept, including when scheduling is disabled or the account is deleted. Successful
account deletion forgets the scoped handle database and encrypted settings, not
user-owned backup files. Backward wall-clock changes make a fresh backup due,
so a future saved timestamp cannot suppress jobs indefinitely.

## Current scope and limits

Scheduled backups now use the combined v2 source: the fourteen typed business
collections plus workspace identity and the owner's own integrations. Other
members' private favorites/integrations, auth credentials, unsent device work and
local activity history remain excluded. This is a user-readable backup, not the
complete operator copy required before migration. Combined recovery limits are
23 MiB and 200,000 records; oversized sources refuse without truncation.

API 30 `privacy.recoveryChallenge`/`privacy.combinedRecovery` require the current
authenticated owner/session, a nonce signature from the unlocked account root
and an entirely standard workspace. Both calls share the workspace transaction
fence; starting preparation between them refuses the original-data read. Source
reads consume the two-minute, at-most-three/account nonce once, verify current
root keys/session and return only owner-readable originals. Responses specify
`Cache-Control: no-store`. Client-side source checks bind origin/account/workspace,
and no private keys, recovery key or session token enter the proof. Old servers
are reported as unsupported instead of falling back to a partial backup.

The writer keeps the v2 outer format, reopens the actual new file and compares
the entire verified archive, including both source checksums, before advancing
its success checkpoint. Old v1 files remain readable. Prepared/encrypted
workspaces refuse this source; the legacy fourteen-collection export is also
fenced to standard mode. Connecting future verified encrypted replicas to
backups remains required.

Lock/account/server changes invalidate pending work. Client requests have a
30-second bound. File errors leave the old success checkpoint and older files
in place; an already verified file may remain if only checkpoint persistence
fails. Failed automatic jobs back off five minutes. Local cleanup failures after
server account deletion are logged and cannot undo server deletion.

This protects saved files against disclosure without the recovery key. It does
not protect data or keys while an attacker controls an unlocked client. Selected
folders, file copies, device security and retention remain under the user's
control. No external upload or backup service is configured.

API behavior follows the [File System Standard](https://fs.spec.whatwg.org/)
and [Chrome's File System Access documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
