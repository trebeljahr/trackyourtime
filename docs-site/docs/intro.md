---
slug: /
title: Track Your Time docs
sidebar_label: Introduction
description: Documentation for Track Your Time, the open-source time tracker you host on your own server. Self-hosting, the MCP server and the REST API.
---

# Track Your Time docs

Track Your Time is an open-source time tracker you host on your own server. It has a web app, a Chrome extension, a Raycast extension and iPhone and Android apps. They all keep tracking without a connection. The hours you track become reports and PDF invoices.

These docs are for three kinds of reader.

**You are deciding whether Track Your Time fits.** [Choosing a self-hosted time tracker](./choosing-a-self-hosted-time-tracker.md) compares it with the other common kinds of tracker and lists what it cannot do yet.

**You want to run it on your own server.** The [self-hosting guide](./self-hosting.md) covers one server, one domain and one Docker Compose file. It includes backups, upgrades, email and troubleshooting.

**You want to connect it to something.** The [MCP server](./mcp.md) lets an AI assistant start timers, log time and read reports. The [REST API](./api/overview.md) and [webhooks](./api/webhooks.md) serve every other integration.

A hosted instance runs at [trackyourtime.dev](https://trackyourtime.dev), and the code is on [GitHub](https://github.com/trebeljahr/trackyourtime) under AGPL-3.0-or-later.

Every page on this site also exists as plain Markdown. Replace the final `/` of a page's address with `.md`, or use `/docs/index.md` for this page. [`/docs/llms.txt`](pathname:///llms.txt) lists all of them.
