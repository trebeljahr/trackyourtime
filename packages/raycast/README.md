# Track Your Time

Start and stop your timer from the keyboard, and see it running in the macOS menu bar. The extension works with the hosted Track Your Time service or with a server you run yourself.

## Commands

| Command | What it does |
| --- | --- |
| **Timer** | Start immediately, then add details while it runs. Start from a favorite, recent work or a project. While a timer runs, stop, edit, move, pin or discard it. |
| **Timer Menu Bar** | Shows the running time in the menu bar. Its menu can stop, edit or discard the timer, continue recent work and show today's total. |
| **Start / Stop Timer** | Stops the running timer, or resumes your latest entry from the past 30 days. It shows the result in a HUD. |
| **Show All Time** | Lists the last 14 days of entries, grouped by day. Continue, edit or delete any of them. |
| **Open Dashboard** | Opens the web app. |

Reports, invoices, the calendar and catalog editing stay in the web app.

### A hotkey for the timer

Open Raycast Settings → Extensions → Track Your Time and record a hotkey for **Start / Stop Timer**. One press stops what is running. If nothing runs, the same press resumes your latest entry.

If there is nothing to resume, it starts a timer immediately and opens its details.

### Start now, add details afterwards

Open **Timer** and press **⏎** on **Start Timer**. The clock starts before the details form opens. You can type a description in the search bar first. Leaving the form keeps the timer running.

Favorites, **Recent Work** and projects in **Quick Start** each start with one selection. Recent work covers the past 30 days. If you use several workspaces, the selector at the top shows which one this Mac tracks into.

Use **Start with Details…** in the action panel when you want to fill everything in before starting.

### Keyboard shortcuts in the forms

Starting a timer, logging past time and editing an entry use the same fields: description, project, task, tags and billable. Projects are grouped by client.

- **⌘⇧N** logs time you forgot to track, in **Timer** and **Show All Time**.
- **⌘⇧D** searches descriptions from the past 180 days. **⏎** takes the name. **⌘⇧⏎** also takes its project, task, tags and billable setting.
- **⌘⇧P**, **⌘⇧T** and **⌘⇧G** create a project, task or tag, and the form selects the new one.

If you belong to more than one workspace, **⌘⇧W** in **Timer** picks the workspace this Mac tracks into.

## Setup

1. Run **Timer** and choose **Sign in to Track Your Time**.
2. The extension shows a short code and opens the approval page in your browser.
3. Sign in to the web app if it asks, check that the code matches, and approve.

You do not create or paste an API key. The session appears as **Raycast** under Settings → Devices in the web app. Sign it out there to remove this Mac's access.

To see your account or sign out from Raycast, press **⌘⇧A** in **Timer**.

### Menu bar item

Run **Timer Menu Bar** once to enable its background refresh. While tracking, the menu bar shows only the elapsed clock. It counts every second, without a colored icon or title settings.

The item is hidden when no timer runs. **When Idle** is the single display preference: turn it on to keep a small monochrome stopwatch for quick access. A timer started from Raycast refreshes the item immediately. A timer started elsewhere while the item is hidden appears on the next background refresh, normally within a minute.

The menu offers **Start Timer**, favorites, recent work and a project shortcut. **Start Timer** starts first and then opens the running entry's details. Editing never pauses the clock.

### Your own server

Track Your Time is open source, and you can host it yourself. Open the extension preferences and set two values:

- **API URL**: your server's address, for example `https://api.example.com`.
- **Web App URL**: the web app on that server, where you approve the sign-in code.

Leave both empty to use `https://api.trackyourtime.dev` and `https://trackyourtime.dev`.

## Offline

You can start, stop, log, move, discard and delete entries with no connection. The extension keeps the changes on this Mac. It sends them in order when the server answers again.

While changes wait, **Timer** and the menu bar show a **Not synced** section with the count. The hotkey's HUD shows the count too.

Some actions need the connection:

- You cannot edit an entry until it syncs. Deleting or discarding it works.
- Creating a client, project, task or tag needs the server.
- Pinning a favorite needs the server.
- Until an entry syncs, its rate and amount are an estimate from the last data this Mac loaded.

Each waiting change records the account, server and workspace it belongs to. If you sign out or change the API URL, the changes stay on this Mac. Another account never sends them. **Timer** lists changes that are not yours to send, and you can discard them after a confirmation.

## Troubleshooting

**Sign-in cannot reach the server.** The extension cannot connect to the server in **API URL**. The sign-in screen shows the server it tried. Choose **Open Extension Preferences** and correct **API URL**.

**Nothing in the menu bar.** Check these in order:

1. Run **Timer Menu Bar** once. A menu bar command appears only after its first run.
2. With no timer running, the item is hidden by default. Turn on **When Idle** to keep a small stopwatch visible.
3. A timer started elsewhere while the item is hidden appears on the next background refresh, normally within a minute.

## Privacy

The extension has no usage analytics. It connects to the server in **API URL** and opens pages of the web app in **Web App URL**.

**Error Report DSN** is optional and empty by default. Leave it empty to send no error reports. If configured, unexpected errors go to your chosen HTTPS endpoint. Reports exclude account details, session tokens, request bodies and entry descriptions.

Your session token is kept in Raycast's encrypted local storage. Cached data and waiting changes stay on this Mac.

## License

This extension, including its copied core/shared code, uses the MIT license. The main Track Your Time web app and server use AGPL-3.0-or-later.
