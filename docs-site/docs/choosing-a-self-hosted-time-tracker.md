---
description: Three kinds of self-hosted time tracker, what each one is good at, when to pick it, and what Track Your Time cannot do yet.
---

# Choosing a self-hosted time tracker

Self-hosted time trackers fall into three patterns, and each one answers a different question. This page describes the patterns and names no products, so it stays accurate as individual projects change. It is part of the Track Your Time documentation, and Track Your Time is the third pattern.

Start with the question you need answered:

- "Who on the team worked on what, and has someone approved it?" leads to a team-first tracker.
- "Where did my day go?" leads to an automatic activity tracker.
- "How many hours do I bill this client this month?" leads to a timer-first tracker such as Track Your Time.

## Team-first trackers

Many of the longest-running self-hosted time trackers are web applications written in PHP. They have years of production use behind them, and they are organised around a company with many users.

What they do well:

- Users, teams and roles, with permissions that decide who sees whose time.
- Timesheet approval by a manager.
- Plugin systems. Invoice templates, expenses and absence tracking often come from plugins.
- Translations into many languages. Some also sign users in through a company directory.

What to expect:

- More to run. A typical install needs a PHP application, a relational database and a web server. Upgrades can include database migrations and plugin updates.
- Time is tracked mainly in the web page. A phone timer that keeps working offline is uncommon, and third parties often supply the mobile apps.
- Some features sit in paid plugins or a paid cloud plan.

Pick a team-first tracker if:

- Several people track time, and someone reviews or approves it.
- You need roles, absences or expenses today.
- A long production history matters more to you than a small install.

## Automatic activity trackers

These run on your own computer. They record which application, window or website is active, and for how long. You never start a timer. The data stays on the machine that recorded it.

What they do well:

- Privacy. Nothing leaves your computer unless you export it.
- A complete record on the days you forgot about tracking entirely.
- Detailed answers about your own attention, down to the window title.

What to expect:

- They record the program you used. Matching that time to a client and a project is left to you.
- They have no clients, projects, hourly rates or invoices.
- Records usually stay on the device that made them. No shared server combines your laptop and your phone.

Pick an automatic activity tracker if:

- You want to understand your own habits, and nobody gets billed for the result.
- No tracking data may leave your computer.
- You forget timers so often that a timer-based tool would stay empty.

## Track Your Time

Track Your Time is a timer-first tracker for a person who bills clients by the hour. You start a timer against a client and a project, and the hours turn into reports and invoices. It runs on your own server from one Docker Compose file on one domain. The [self-hosting guide](./self-hosting.md) has every command.

What it does:

- The timer runs in the web app, a Chrome extension and iPhone and Android apps. A Raycast extension adds a Mac menu bar clock and a hotkey.
- Each of these keeps tracking without a connection. The queued changes go to the server when the connection returns.
- A timer you stop on one device stops on every other open device at once.
- Each project has an hourly rate. Summary, detailed and weekly reports export to CSV and PDF.
- An invoice collects a client's unbilled billable hours and downloads as a PDF. An hour on an invoice can't be billed a second time.
- You can export a whole workspace as JSON or CSV. A CSV from another tool imports with a preview, and you can undo the import.
- A [REST API](./api/overview.md) with an OpenAPI document, signed [webhooks](./api/webhooks.md) and an [MCP server](./mcp.md) connect it to other tools and to AI assistants.
- The licence is AGPL-3.0-or-later. Every install has every feature, and there is no paid tier.

What it cannot do yet:

- The web app cannot invite team members. The data model has workspaces with members, but in practice one account is one private workspace.
- There is no tagged release, so there are no published Docker images. The first start builds the images from source and needs about 4 GB of RAM.
- Anyone who can reach your domain can create an account. The application has no setting to close sign-up, and the self-hosting guide lists workarounds at the proxy.
- The Chrome extension, the Raycast extension and the phone apps are not in any store yet.
- The Chrome extension has its server address compiled in. For your own server, you edit one config file and build it. The Raycast extension has server preferences, so one build works with any server.
- The phone apps reach only the hosted service at trackyourtime.dev. On your own server, use the web app in your phone's browser.
- It has no timesheet approval and no expense or absence tracking. English is the only language.

Pick Track Your Time if:

- You bill clients by the hour, and your tracked time ends up on an invoice.
- You want a timer in your browser, your menu bar and your phone, and it has to work without signal.
- You want the data on your own server, and one person tracking is enough for now.
- You want to connect your time data to other tools through an API, webhooks or an AI assistant.

## Using two patterns together

An activity tracker and a timer-first tracker can run side by side. The activity record shows what you worked on during a stretch you forgot to time. Track Your Time takes that stretch as a past entry from the web app, the Chrome extension, the Raycast extension or the MCP server. Billable hours logged that way reach the next invoice like any other.
