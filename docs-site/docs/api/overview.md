---
sidebar_position: 1
description: The public REST API at /api/v1 — base URL, response envelope, cursor pagination, and what an API token can and cannot reach.
---

# REST API

`https://api.trackyourtime.dev/api/v1` is a token-authenticated REST API over
the same data the web app, the browser extension and the Raycast extension use. It
reads and writes time entries, the catalog behind them (clients, projects, tasks,
tags) and reports over both.

It is a separate surface from the tRPC endpoint the first-party clients speak. They
share the service layer underneath, not the transport: a REST write publishes the
same realtime sync event and enqueues the same webhooks, so a timer started over HTTP
appears in an open browser tab immediately.

## Getting started

1. Mint a token in **Settings → Integrations**, ticking only the scopes you need.
2. Send it as `Authorization: Bearer tt_…` on every request.
3. Confirm what it can reach:

```bash
curl -s https://api.trackyourtime.dev/api/v1/me \
  -H "Authorization: Bearer $TRACKYOURTIME_TOKEN"
```

```json
{
  "data": {
    "tokenId": "665f…",
    "workspaceId": "664a…",
    "userId": "6612…",
    "scopes": ["entries:read", "entries:write"],
    "visibility": { "canViewOthersTime": false, "canViewOthersMoney": false }
  }
}
```

See [Authentication](./authentication.md) for the scope table and what those
visibility flags change.

## One token, one workspace

A token is bound to the workspace it was minted in and cannot address another. There
is no `workspaceId` parameter anywhere in the API; sending one that names a different
workspace is refused with `400 workspace-not-addressable` rather than quietly serving
the bound one.

Anything belonging to another workspace answers `404`, never `403`. A 403 on a foreign
id would confirm that the id exists somewhere, which turns every endpoint into an
enumeration oracle. `403` is reserved for a refusal about a resource this workspace
genuinely owns — the wrong scope, or money the token may not see.

## The envelope

Every successful response is a JSON object with a `data` key:

```json
{ "data": { "id": "665f…", "durationSec": 3600 } }
```

A list adds `nextCursor`:

```json
{ "data": [ /* rows */ ], "nextCursor": "MjAyNi0wOS0wN…" }
```

`nextCursor` is **always present** and `null` on the last page. It is never omitted:
an absent key would make "no more pages" indistinguishable from a serialization bug,
and a paging client would stop early without noticing.

Errors are not enveloped. They are
[RFC 9457 problem documents](./errors.md) with their own media type.

## Pagination

`GET /entries` and `GET /reports/detailed` are cursor-paged. Pass `limit` (1–500,
default set by the server) and then feed each response's `nextCursor` back as the
`cursor` parameter until it comes back `null`:

```bash
curl -s -G https://api.trackyourtime.dev/api/v1/entries \
  -H "Authorization: Bearer $TRACKYOURTIME_TOKEN" \
  --data-urlencode "from=2026-09-01" \
  --data-urlencode "to=2026-09-30" \
  --data-urlencode "limit=100" \
  --data-urlencode "cursor=$NEXT_CURSOR"
```

A cursor is **opaque**. It encodes a sort key and an id, not an offset, so rows
inserted while you page do not shift the window and nothing is skipped or repeated.
Store it verbatim and send it back unchanged — do not decode it, and do not construct
one.

The catalog lists (`/clients`, `/projects`, `/tasks`, `/tags`) are not paged: a
workspace's catalog is small by construction. They still answer with
`nextCursor: null` so one list parser works everywhere.

## Query parameters

Array filters accept either spelling:

```
?projectIds=664a…&projectIds=664b…
?projectIds=664a…,664b…
```

Dates are ISO-8601. A range filter (`from` / `to`) takes either a calendar day
(`2026-09-01`) or a full timestamp (`2026-09-01T08:00:00Z`). Every timestamp the API
*emits* is a full ISO-8601 UTC string.

Report routes take an optional `timeZone` (an IANA name such as `Europe/Berlin`)
because day bucketing depends on it. Without one the server buckets in its own zone —
UTC on a deployment — and files after-midnight work under the previous day.

## The machine-readable contract

- [`openapi.json`](pathname:///openapi.json) — the committed OpenAPI 3.1 document.
- `GET /api/v1/openapi.json` — the same document from the running server,
  unauthenticated, generated on each request from the server's own route table.

Both are generated from the array that mounts the routes and from the very zod schemas
that validate the requests, so a route cannot exist undocumented and a field cannot be
documented with a shape it does not have. Point a client generator at either.

## What is not here

- **Invoices.** Money end to end, with no field left to strip for a token whose owner
  may not see it. Read them in the web app.
- **CSV and PDF exports.** Same reason: they bake amounts into bytes, so there is
  nothing to project.

Both are deliberate omissions rather than gaps waiting to be filled.
