# Local startup measurement

Instrumentation stays in browser User Timing and HTTP response headers. It adds
no requests, storage, logs, analytics, tracing headers, or uploads. Names are fixed;
no account, workspace, token, request input, or entry data is attached.

## What the numbers mean

- `tyt:login-submitted`: password login begins (includes a subsequent 2FA step).
- `tyt:authentication-ready`: AuthProvider has a resolved authenticated session.
- `tyt:tracker-useful-data-ready`: authenticated tracker has successful current-timer,
  entry-list, and project results committed in React. Empty results count. Cached
  results count; failed queries and offline timer mirrors alone do not. This is
  data availability, not a paint or interaction latency measurement.
- `tyt:startup-to-auth` / `startup-to-tracker`: document time origin to those milestones.
- `tyt:login-to-auth` / `login-to-tracker` / `auth-to-tracker`: milestone intervals.
  New password attempts and sign-out clear prior app marks/measures.
- `Server-Timing: auth`: better-auth handler work on auth routes; session validation
  on tRPC. Auth handler body parsing/serialization and network transfer are excluded.
- `workspace`: summed procedure time waiting for workspace resolution, including
  waits on the request's shared membership lookup. `data`: summed downstream
  workspace-procedure execution, including input validation and result shaping.
  Batched work overlaps, so sums may exceed request wall time; never subtract them
  from the request duration. Streaming batches send headers before all operations
  finish: the header is a snapshot of completed phases only; later phase timings
  are omitted. Use individual unbatched requests when comparing full server phases.
  REST v1 and non-workspace procedure data are unmeasured.

Trusted cross-origin auth/tRPC responses get exact `Timing-Allow-Origin`, based on
existing CORS approval, and expose `Server-Timing` for Fetch. Rejected origins get
no timing grant; preflights themselves are unmeasured. See [Server-Timing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing).

## Reproduce

1. Use a disposable local account and fixed small dataset on a local API. Check
   load/memory first. Run `pnpm dev:auto` with existing local DB services; record
   printed ports, commit, browser/version, dataset size, and dev versus production
   build. Do not measure against production or mix build modes. Stop owned servers
   afterward. Next development compilation makes first-run timings unrepresentative.
2. Browser DevTools Network: record existing auth/tRPC request count and Timing tab.
   Keep the local API cross-origin to verify `Timing-Allow-Origin` and `serverTiming`
   visibility. Do not save HARs or response bodies (they can contain credentials).
3. Cold browser startup: use a fresh browser context for each run, sign in, then
   wait for tracker. Cold here means empty browser connection/cache state, not a
   cold database or server. Separately label any deliberately restarted server run.
4. Warm authenticated startup: in the same context, reload `/app/track`, retaining
   cookies and browser cache. Each reload has a fresh timing buffer. For warm login,
   sign out and sign back in; collect the distinct `login-*` intervals.
5. Repeat both conditions with DevTools network throttling set to one fixed profile
   (for example custom 150 ms latency, 1.6 Mbps down, 750 Kbps up). Keep CPU throttling
   off. Record profile and request counts; it affects network, not DB execution.
6. After each successful run, use this console snippet. Copy only its numeric output
   into local measurement notes. Missing milestones mean incomplete/failed runs;
   record their count separately, never replace them with zero.

```js
Object.fromEntries(performance.getEntriesByType('measure')
  .filter(e => /^tyt:(startup-to-auth|startup-to-tracker|login-to-auth|login-to-tracker|auth-to-tracker)$/.test(e.name))
  .map(e => [e.name, Number(e.duration.toFixed(1))]));
```

For server phases inspect the Network Timing tab or
`performance.getEntriesByType('resource').filter(e => e.serverTiming?.length)`
in the console; retain only fixed phase names and durations, never resource URLs.
Use browser request duration for wall time, and server phases for attribution.

Keep samples separate per condition and metric. Report raw counts/range first.
Only calculate p50/p95 with at least 100 actual successful runs per condition
(nearest rank: sorted sample at `ceil(n * percentile) - 1`); also report failures.
No production timings or percentile results have been collected by this change.

## Independent reads (API level 16)

- Pickers and management tables share `*.options({ includeArchived: true })`.
  Active-only pickers filter the same cached metadata locally. These procedures
  do not read time entries. Task/project associations use `tasks.projectLinks`
  independently, so their aggregation cannot delay task names.
- Management screens attach statistics from the existing `*.list` procedures.
  Names remain usable while numeric cells show a dash. Complete list reads and
  optimistic edits also seed metadata; metadata never fabricates statistics.
- The local catalog snapshot includes metadata and management lists, within
  the existing size and retention limits. Restoration still requires a live
  session and confirmed workspace membership, with matching access rights.
- `reports.rows` reads only the requested page. `reports.totals` folds the full
  filtered range independently and has no cursor in its cache key. Rows use a
  separate transport batch even without streaming support. The older
  `reports.detailed` contract remains available to existing clients.
- Initial HTTP queries no longer wait for the sync socket. Room placement
  reconciles completed and in-flight pre-subscription snapshots; a late result
  gets one catch-up read after it settles. The legacy socket timeout controls
  reconciliation only, without holding the initial HTTP request.

For regression checks, hold statistics/totals responses in a synthetic local
fixture. Confirm names/rows render before release, pagination leaves the totals
request count unchanged, and a write between the first read and socket room
placement appears after catch-up. Distinguish these controlled checks from
production latency measurements.
