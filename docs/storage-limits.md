# Storage and import limits

The server imports plaintext time records from CSV and workspace JSON exports.
It does not retain uploaded files or offer a general backup-file store. Encrypted
envelopes, arbitrary JSON and binary files are refused. Recognized fields are
validated and normalized; unknown export fields are ignored. Text disguised as
a legitimate description cannot be identified reliably as encrypted content, so
content validation is combined with resource limits.

## Import requests

- Each file: 8,000,000 UTF-8 bytes and 25,000 time-entry rows.
- CSV: at most 512 columns and 16,000 characters per cell.
- Each entry: at most 20 tags; tag names at most 60 characters.
- JSON: at most 25,000 combined catalog, favorite and invoice records and 32 levels of nesting.
- Each user and each workspace: 60 preview/commit attempts and 128 MiB of JSON request payload per fixed clock hour. Preview and commit each consume a request; failed validation consumes budget too.
- One active preview or commit per user and workspace. Five-minute leases recover abandoned requests. An expired lease cannot commit after another request takes over.

Budgets live in MongoDB and apply across server processes. If the shared budget
store is unavailable, imports fail closed. Old hourly counters expire after the
following hour. Only a single import procedure receives the larger HTTP body
limit, including a single-item tRPC batch; mixed batches retain the normal 100 KB
limit. Reverse-proxy body, connection and request limits should also be set for
the deployment: the authenticated import budget is checked after HTTP decoding.

## Persistent storage

`STORAGE_QUOTA_BYTES` defaults to **512 MiB per owner account**, shared across all
workspaces it owns. The same allowance also bounds each workspace. A shared
workspace counts against each current owner; ownership transfers therefore do
not reset its allowance. Self-hosters can raise the positive integer in their
environment. Invalid values fall back to the default; zero does not disable it.

This is an **accounting allowance**, not a measurement of compressed disk usage.
Each persistent workspace record is charged its BSON size or 4 KiB, whichever is
larger, to cover record/index overhead. A running timer reserves an additional
8 KiB for stopping and its durable replay receipt. Normal entries, catalog rows,
invoices, settings, memberships, import receipts, offline-operation receipts,
API tokens, webhook subscriptions and timesheet records all count. Deleting an
entry does not delete its retained replay or import receipts.

Profile/avatar data has its existing separate bounds. Expiring webhook delivery
logs, authentication records, operational fences and import-rate metadata are
outside this accounting allowance. The quota is not a complete filesystem or
infrastructure spending cap.

Quota checks and record changes use the same MongoDB transaction. Account and
workspace fences serialize concurrent writers; a failed check rolls back the
whole transaction. Imports therefore roll back their catalog, settings and
receipt writes too. Team creation commits its auth organization, membership,
settings and owner mirror together, so failed attempts leave no orphan records.
Enforcement lives on the persistent models, covering tRPC,
REST, timer services and background jobs. Unsupported bulk/pipeline mutations
fail closed. A replica set or `mongos` is required; standalone workspace writes
are refused rather than silently omitting the quota.

Existing data is measured on the first write after rollout. Later writes update
small per-workspace ledgers, rather than rescanning history. Existing records,
reads and exports remain accessible when over allowance; shrinking and deletion
remain possible. Quota refusals use HTTP 412 so offline clients retain queued
time. Account deletion can transfer an existing workspace to a successor who
is over allowance, but that successor cannot add content until usage falls or
the operator raises the allowance. No time records are automatically pruned.

Native collection writes bypass model guards and are reserved for migrations
and operator maintenance. After such a write, invalidate the affected workspace's
`storageusages` row before serving writes. Accounting version changes require a
new baseline. Do not run older writers alongside this version during rollout.
