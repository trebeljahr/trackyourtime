# Security Policy

## Supported versions

Track Your Time is pre-1.0. The root `package.json` says `0.1.0`, there are no
tagged releases, and there are no maintenance branches. Security fixes land on
the latest commit of `main` and nowhere else.

| Version                | Supported          |
| ---------------------- | ------------------ |
| Latest commit on `main` | Yes               |
| Any older commit        | No                |
| Deployed images built from an older commit | No |

If you run a self-hosted instance, "supported" means: update to current `main`
and rebuild. There is no backport path.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

**Email <ricotrebeljahr@gmail.com>.** That is the whole channel, and it is
monitored.

GitHub's private vulnerability reporting is **not** enabled on this repository,
so `/security/advisories/new` is maintainer-only and there is nothing for an
outside reporter to submit there. Do not let that push you into opening a public
issue — email instead. If the setting is turned on later, this section and the
routes in `SUPPORT.md`, `CONTRIBUTING.md` and
`.github/ISSUE_TEMPLATE/config.yml` get updated together.

## What to include

The more of this you can give, the faster it gets triaged:

- **Affected component** — server, web client, browser extension, Raycast
  extension, Electron shell, or the deployment configuration.
- **Version or commit** — the commit SHA you tested against, or the host if you
  found it on the hosted app.
- **Reproduction** — concrete steps, requests, or a minimal proof of concept.
  Say what setup you were running (self-hosted, local dev, hosted app).
- **Impact** — what an attacker gets: read access to another account's time
  entries, session takeover, remote code execution, denial of service, and so
  on. A plain sentence is enough; no CVSS vector required.
- **How you would like to be credited**, if at all.

## What to expect

This is a small project maintained by one person in their spare time. Timelines
are best-effort, not contractual:

- **Acknowledgement within 7 days** that the report arrived and was read.
- **An assessment within 30 days** — whether it is confirmed, what the severity
  looks like, and what the intended fix is.
- **A fix when there is one.** Once it lands on `main`, the advisory is
  published and you are credited if you wanted to be.

There is **no bug bounty program** and no payment of any kind. If you need a
paid disclosure process, this is not the project for it.

## Scope

**In scope:** vulnerabilities in the code in this repository — the tRPC API and
its authorization checks, workspace scoping, session and device-flow
authentication, the WebSocket upgrade path, the import and export paths, and
the client applications.

**Out of scope:**

- **Misconfiguration of a self-hosted instance.** Running an instance is the
  operator's responsibility: secrets, TLS, the reverse proxy, database and
  Redis exposure, `TRUSTED_ORIGINS`, backups, and OS patching. A deployment
  that leaks because the database was published to the internet is a
  configuration problem, not a vulnerability in this project. If the
  documentation led you into the misconfiguration, that is worth reporting as a
  documentation bug.
- Vulnerabilities in third-party dependencies with no exploitable path through
  this code. Report those upstream; a note here is still welcome.
- Findings from automated scanners with no demonstrated impact.
- Denial of service through sheer traffic volume against the hosted instance.
- Social engineering of the maintainer or of users.

## Credit

Reporters are credited by name or handle in the published advisory if they want
to be. Say so in your report; the default is to ask before naming anyone.
