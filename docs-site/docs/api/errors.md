---
sidebar_position: 3
description: RFC 9457 problem+json error bodies, the full slug table, and what each status means on this API.
---

# Errors

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem documents, sent
as `Content-Type: application/problem+json`:

```json
{
  "type": "https://trackyourtime.dev/problems/insufficient-scope",
  "title": "Forbidden",
  "status": 403,
  "detail": "This token does not carry the `entries:write` scope.",
  "instance": "/api/v1/entries"
}
```

- **`type`** identifies the failure. Branch on this, not on the prose in `detail`.
- **`title`** is the HTTP status phrase.
- **`status`** repeats the HTTP status, so a logged body is self-contained.
- **`detail`** is human-readable and may change wording between releases.
- **`instance`** is the path that produced it.

Error bodies are not wrapped in `{ "data": … }`. The media type tells them apart from
a success before you parse: `application/problem+json` versus `application/json`.

## The slugs

Each `type` is `https://trackyourtime.dev/problems/` plus one of:

| Slug | Status | Means |
| --- | --- | --- |
| `invalid-request` | 400 | The request failed validation. `detail` names the fields. |
| `workspace-not-addressable` | 400 | You sent a `workspaceId` naming a different workspace than the token's. Remove it. |
| `invalid-token` | 401 | Missing, malformed, unknown, revoked or expired token — or its owner is no longer a member. |
| `insufficient-scope` | 403 | The token does not hold the scope this route requires. |
| `money-visibility-required` | 403 | The response would span other members' time and this token may not see what it is worth. Returned by the report routes and by `GET /entries`. |
| `forbidden` | 403 | A refusal about a resource this workspace owns that is none of the above. |
| `not-found` | 404 | No such resource in this token's workspace. |
| `no-such-route` | 404 | No route matches that method and path. |
| `conflict` | 409 | The write collides with existing data — a duplicate name, an entry already invoiced. |
| `client-too-old` | 412 | The request sent `x-trackyourtime-api-level` below the lowest level this server serves. Update the client. A request without that header is never refused this way. |
| `payload-too-large` | 413 | The request body exceeds what the route accepts. |
| `rate-limited` | 429 | See [Rate limits](./rate-limits.md). |
| `internal-error` | 500 | Something broke on the server. |

## Reading the statuses

**404 covers "not yours".** A resource in another workspace, or one your visibility
hides, is reported as missing rather than forbidden. A 403 on a foreign id would
confirm the id exists somewhere. So a 404 means *"not addressable by this token"*, and
does not by itself prove the id is unused.

**403 is always about permission on something this workspace owns** — the wrong scope,
or money the token may not see.

**409 is a real conflict, not a validation failure.** Two catalog rows with the same
name in the same parent, or an edit to an entry that has been invoiced. Retrying
unchanged will fail again.

**A 500's `detail` is always the same fixed string**, in every environment:
`"The server could not complete this request."` The real error goes to the server log
instead. A driver's message routinely carries collection names, query shapes and
occasionally values, and an API response is the wrong place to find out.

## Retrying

| Status | Retry? |
| --- | --- |
| 400, 403, 404, 409, 413 | No. The request will fail identically. Fix it. |
| 401 | No, until the token is replaced. |
| 429 | Yes, after `Retry-After` seconds. |
| 500 | Once or twice, with backoff. If it persists, it is not your request. |

Writes are not idempotent — there is no idempotency key. A retried `POST /entries`
that actually succeeded the first time creates a second entry, so retry a write only
on a 429 or a transport failure with no response, and reconcile by listing the range
afterwards if you cannot tell which happened.
