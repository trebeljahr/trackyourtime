# Personal GitHub effort estimates

`node scripts/github-effort-plan.mjs /private/input.json /private/plan.json`
creates an offline plan. It never contacts GitHub, reads credentials, or writes
to a tracker. Keep inputs, outputs, commit messages and personal records outside
the source repository. The output must not exist already.

Collect an explicit allowlist of personal repositories first. Exclude client,
employment and ambiguous repositories **before reading their history**. Include
authored non-merge commits from all relevant branches and former author
identities. Exclude bots, generated checkpoints and upstream contributions by
other people. Shared SHAs across forks and branches count once. Record any
collector gaps; absence of evidence is not zero effort.

Input fields:

- `commits`: `{ repository, sha, date, subject, stats? }`. `stats` contains
  `files`, `lines` (additions plus deletions), and `binary`, excluding generated
  files, lockfiles, vendored sources and build output. Dates are author dates.
- `repositoryProjects`: explicit mapping from repository name to project name.
- `projects`: personal project catalog with `_id`, `name`, `clientId`, and
  `billableDefault: false`. `personalClientIds` explicitly allows self-clients.
- `entries`: personal entries only, with `billable: false`, `projectId`,
  `clientId`, `start`, `end`, `durationSec`, `tagIds`, and optionally `invoiceId`.
- `reconstructedTagIds`: tags identifying prior inferred history. These
  entries occupy time but cannot calibrate the model.
- `blockedDays`: dates reserved server-side without returning client records.
- `baselineCutoff` and `aiSurge`: era boundaries. Each era calibrates separately
  from matched personal project-days; fewer than eight samples explicitly falls
  back to the baseline. The baseline itself requires eight matched days.
- `guardDays`: 0–2, default 1. Reserve neighboring dates to allow for historical
  timezone changes. `now` optionally closes running intervals for planning.

The model uses relative log-scaled change size, calibrated against tracked
project-days. A daily cap, derived from baseline personal days, is shared across
repositories. It does not turn commit gaps or lines of code into measured time.
Missing diffs and AI-era activity widen the plausible ranges. These are not
statistical confidence intervals; uncertainty within a day is correlated.

`projectDays` includes per-commit effort shares and ranges even for dates on
which no time can safely be added. `newEntries` contains only uncovered dates,
with synthetic, non-overlapping bookkeeping blocks explicitly labelled as
estimates. The hash of repository and date gives each block a stable identifier.
Apply with an atomic insert-only upsert and re-check occupancy against live
entries inside the write transaction. A stale plan must fail and be regenerated.

`projectEstimates` credits existing time per project-day before including the
model residual. `estimatedHours` describes the possible lifetime build effort;
`loggedHoursAfterImport` describes actual records after the proposed import.
They are different quantities. Some blocked dates cannot be attributed to
individual projects; `includesAmbiguousCoveredDates` flags this limitation.
Never sum these estimates with generic coding/learning time as independent
measurements. Earlier reconstructed time is held fixed, not treated as precise
ground truth for the bounds.

Apply through an undoable import batch. Store all commit-level evidence and the
exact inserted IDs privately. Do not replace manual descriptions, timestamps,
rates, or billable/client records. Existing project budgets need a deliberate
decision before replacement. Re-running must neither insert the same block
twice nor revise previously imported blocks silently.

## Hidden automation tags

Create or update a tag with `hidden: true`. Catalog lists exclude it unless
`includeHidden: true` is explicitly requested. The REST and MCP schemas expose
both fields. Existing entry/report `tagIds` filters continue to work with hidden
IDs; `GET /tags/:id` resolves one directly. Hidden state survives JSON exports
and restoration of missing tags.

Normal pickers, chips, and report tag-group labels omit hidden tags. Entries
carrying only hidden tags appear under “No tag” in normal tag grouping. Hidden
tags are presentation metadata, not an access-control boundary. Deploy the
server change before applying hidden provenance tags to live data.
