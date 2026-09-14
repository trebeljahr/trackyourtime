---
sidebar_position: 2
description: Minting an API token, the scope table, how a token's visibility is resolved, and what revoking one does.
---

# Authentication

Every route but `/openapi.json` requires an API token:

```
Authorization: Bearer tt_Ab3xY9Zq_kR2…
```

There is nothing else to configure. No OAuth dance, no signing of requests, no
separate API key and secret.

## Minting a token

**Settings → Integrations → New token.** Give it a name, tick the scopes it needs, and
optionally set an expiry date.

The plaintext is shown **once**, at creation, and is never recoverable afterwards —
only a SHA-256 hash of it is stored. If you lose it, revoke that token and mint
another. What the settings screen shows from then on is the token's non-secret
prefix (`tt_Ab3xY9Zq…`), which is enough to tell two tokens apart in a list and
useless as a credential.

A token looks like `tt_<prefix>_<secret>`: an 8-character prefix used to look the row
up, and a 43-character secret carrying 256 bits from the system CSPRNG. Send the whole
string; the prefix alone authenticates nothing, because the stored hash covers the
entire token.

## Scopes

Scopes are deny-by-default. A token grants exactly the scopes ticked when it was
minted, and a route refuses with `403 insufficient-scope` unless its scope is among
them. A token with no scopes at all is legal and can do nothing — which is the correct
behaviour for an empty list, not an edge case to guess around.

| Scope | Grants |
| --- | --- |
| `entries:read` | List, fetch and page time entries; read the running timer. |
| `entries:write` | Create, edit and delete entries; start and stop timers. |
| `catalog:read` | List and fetch clients, projects, tasks and tags. |
| `catalog:write` | Create, edit, archive and delete catalog rows. |
| `reports:read` | Summary, detailed and weekly reports. |

Write does **not** imply read. A route that needs `entries:read` needs it even if the
token holds `entries:write` — so a token that only pushes entries in cannot be turned
around and used to read the workspace's history.

[The reference](./reference.md) names the required scope for every route, and so does
the OpenAPI document, as `x-required-scope` on each operation.

## What a token can see

A workspace member has two visibility flags, both off by default:

- **`canViewOthersTime`** — see other members' entries, not only your own.
- **`canViewOthersMoney`** — see hourly rates and the amounts derived from them.

A token carries its creating member's flags, resolved on **every request** and
intersected with the flags that member had when the token was minted. Two rules fall
out of that, and both matter:

- **Revoking a permission narrows the token immediately.** A member demoted today
  stops seeing colleagues' money through a token minted last year, on the next
  request.
- **Granting a permission does not widen it.** A token minted under a narrower grant
  keeps that ceiling; to use a newly granted permission, mint a new token. Nobody
  should discover that a year-old credential silently gained reach.

Removing the member from the workspace kills their tokens outright: `401`, not `403`.
There is no membership left to derive a scope from.

`GET /me` reports the *effective* flags, so a client can decide whether to render a
money column at all rather than discovering the answer from a 403 three screens later.

### How money is withheld

Where a response can honestly be narrowed, it is:

- `GET /entries` and `GET /entries/:id` set `hourlyRate: null` on any row whose author
  is not you when `canViewOthersMoney` is off. When the rate is withheld, `amount` is
  `null` too — never `0`, which is what unbillable time earns. Branch on `null` before
  showing any figure.
- `GET /projects` and `GET /projects/:id` set `progress` to `null`. Budget progress
  spans every member's entries, so `spentAmount` is aggregate colleague earnings.

Where it cannot, the request is refused: `GET /reports/*` answers
`403 money-visibility-required` when a token may see colleagues' *time* but not their
*money*. A report is totals; there is no honest stripped version of a total. Zeroing
it produces a page of numbers a spreadsheet will sum, and omitting it produces a
report whose own figures do not reconcile.

Both other combinations are served normally. With `canViewOthersTime` off the rows are
your own, so every amount in the report is your own earnings; with both flags on there
is nothing to withhold.

## Revoking

**Settings → Integrations** lists every token with its prefix, scopes, expiry and last
use. Revoking one takes effect on the next request — there is no cache to wait out.
An expired token is refused the same way.

Deleting an account deletes every token that account minted, and every webhook it
created. Requests with those tokens answer `401`, and those webhooks send nothing
more.

Every failure — unknown, malformed, revoked, expired, belonging to a removed member
or to a deleted account — answers the same `401 invalid-token` body. Telling those apart would confirm
which prefixes exist.

`lastUsedAt` is written at most once a minute per token, so a token used ten times a
second does not turn its own row into the hottest document in the database. Treat it
as "was this used today", not as an audit log.

## Not the same as a client session

The browser extension, Raycast and the desktop and mobile builds do not use API
tokens. They sign in as you and keep a better-auth **session** token, which the server
accepts on the tRPC surface. Those appear under **Settings → Devices** and are revoked
there.

API tokens are the credential for *your own* integrations: scripts, CI jobs,
third-party tools. They are scoped, a session is not; a session follows a person's
full permissions, a token can only ever hold a subset.
