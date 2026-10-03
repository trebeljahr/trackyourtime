# Member rates and timesheet approvals

Member rates apply to new rate snapshots. Resolution is project override,
entry author's workspace-member rate, then workspace default. Null inherits;
zero is deliberate. Editing a description or a time boundary preserves the
historical snapshot. Explicit imported numeric rates also survive, including
zero. Project repricing remains an explicit, author-only action. It refuses
if any affected entry belongs to a locked period. A member's own rate is
visible to that member; other rates require monetary visibility. Changing
rates requires owner/admin and monetary visibility. Resolved settings expose
only the caller's `memberHourlyRate`; the editable workspace default stays separate.

## Supported database setup

Tracking works with standalone MongoDB. Approvals are optional and default off.
Activation requires transactions: a replica set or a supported sharded cluster.
A standalone server refuses activation with `TIMESHEET_TRANSACTIONS_UNAVAILABLE`.
It never substitutes a process mutex or expiring lease for a database transaction.

For a self-hosted **single-node replica set**, this repository includes the
opt-in `docker-compose.selfhost.approvals.yml` override. This is still one
MongoDB instance, without high availability. It retains the existing named
volumes and does not expose a MongoDB port. The existing base compose network
remains private. Do not add public database access to enable this feature.

Before applying the override to existing data, make a full `mongodump` backup
and verify it can be restored into an isolated database. Stop application
writers during the conversion. Inspect the rendered configuration first:

```sh
docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.approvals.yml config
```

Then apply the same two files together with `up -d`. The opt-in health check
initializes `rs0` only when it is not initialized, and waits for a primary.
The server waits for MongoDB's health check in the base compose. If you set
`MONGODB_URI` explicitly, include `replicaSet=rs0` for this setup. Managed MongoDB
uses the provider's own connection string instead. Restart the application
server after changing the topology; its capability check is cached per
connection. Never apply this override to an unrelated existing replica set.

Enable the feature in Settings → Workspace, choose the review time zone, and
optionally require approved time for invoices. Turning it off requires all
submitted/approved periods to be withdrawn or reopened first. Existing period
bounds stay fixed when time zone or week start changes.

## Workflow and invariants

The author submits a week after confirming it online. Local pending or held
edits disable submission. The server rejects weeks intersecting a running
entry or an entry crossing the boundary; stop or split those entries first.
Reviewers need owner/admin plus time visibility. Money visibility is independent.
The review response contains time fields only, with no invoice identifiers or
rates. The review queue puts submitted weeks first and paginates both periods
and their entries.

Submitted and approved periods lock every instant in their stored UTC range,
including empty days. Future weeks cannot be submitted: a locked future period would intersect an
open-ended timer started today. Authors can withdraw submitted time. Reviewers can approve
or reject submitted time. Rejection and reopening require a reason. Reopening
approved time is refused if any entry is invoiced. Rejected/reopened time can
be edited and resubmitted. Actions compare the revision to reject stale clicks.
An append-only action history records actor, time, and reason.

`withBusinessTransaction(work)` is the domain transaction boundary. Mongoose 9
`transactionAsyncLocalStorage` propagates the session. `businessReads` takes
thunks and runs them sequentially within a transaction; do not launch parallel
queries on that session. External publication is deferred until commit and
aborted attempts discard their publication callbacks. Email is not part of
these transactions.

`TimeEntry` query/save/insert boundaries enter a transaction automatically when
the topology supports it. Every entry write and submission contends on the same
`WorkspaceWriteFence` row. There is no lease expiry: a paused or expired writer
cannot commit across a competing submission. Guards check the original and the
proposed interval. Unsupported replacement/pipeline/bulkWrite operations fail
closed. Use guarded `updateMany` for bounded bulk changes. Never bypass the
model with raw collection writes in application code.

The model boundary covers CRUD, REST, timers, backdating, runaway handling,
project repricing, catalog detachment, tag cascades, imports/undo and invoice
claims. Account deletion also respects entry locks; withdraw or reopen affected
non-invoiced time before deleting its author. Shared-workspace invoiced time and
approval audit records remain with the workspace. Domain transactions also keep multi-step catalog/import/invoice work
atomic. Invoice attribution is the sole exception to a locked entry's ordinary
write ban: approved time may be claimed/released, but its tracked work remains
frozen. Submitted time is excluded from invoice previews. When the invoice
policy is enabled, unapproved time is also excluded with an explicit count.
Claim-time guards recheck eligibility under the workspace fence.

Conflicts have stable `TIMESHEET_*` messages and tRPC `data.approvalRefusal`.
`TIMESHEET_LOCKED` becomes a queue-v2 recovery hold in offline clients: retain
the local change for deliberate retry after withdrawal or reopening. Never discard it as a
permanent validation failure. API capabilities are `members.rates` and
`timesheets.approvals`; older servers hide these controls.

JSON exports contain approval history, policy, and visibility-filtered member
rates as export-only records. Ordinary imports never restore these authorities.
A full database backup is the restore mechanism for approval state, identity,
invoice relationships, and fence records; restore it while writers are stopped.
Do not run older application versions which lack these guards against a database
with active approvals.

## Validation

The database tests use isolated throwaway databases through `TEST_MONGODB_URI`.
Run `approvals-transactions.test.ts` against both standalone MongoDB and a replica
set; transactional cases explicitly skip on standalone. Replica-set tests cover
paused writers, competing submissions, invoice/reopen races, rollback, whole
empty-period locks, author/workspace isolation, and calendar changes. They must
run against real MongoDB, not stubbed query middleware. Run the rate, membership,
import/export, invoice, catalog, and client localization suites too.
