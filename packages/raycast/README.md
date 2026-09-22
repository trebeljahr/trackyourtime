# Track Your Time

Start and stop your timer from the keyboard, and see it running in the macOS menu bar. The extension works with the hosted Track Your Time service or with a server you run yourself.

## Commands

| Command | What it does |
| --- | --- |
| **Timer** | Start a timer from a form, a favorite or recent work. While a timer runs, stop, edit, move, pin or discard it. |
| **Timer Menu Bar** | Shows the running time in the menu bar. Its menu can stop, edit or discard the timer, continue recent work and show today's total. |
| **Start / Stop Timer** | Stops the running timer, or resumes your latest entry from the past 7 days. It shows the result in a HUD. |
| **Show All Time** | Lists the last 14 days of entries, grouped by day. Continue, edit or delete any of them. |
| **Open Dashboard** | Opens the web app. |

Reports, invoices, the calendar and catalog editing stay in the web app.

### A hotkey for the timer

Open Raycast Settings → Extensions → Track Your Time and record a hotkey for **Start / Stop Timer**. One press stops what is running. If nothing runs, the same press resumes your latest entry.

If there is nothing to resume, the press opens **Timer** so you can describe the work first.

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

Run **Timer Menu Bar** once, and the item stays in the menu bar. Its preferences set what it shows while a timer runs and while none does. They can also hide the item when no timer runs.

With **Clock** on, the time counts every second, and a stop made on another device shows up within seconds. With **Clock** off, the menu bar updates once a minute.

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
2. Check the **Idle** preference. When it is on, the item is hidden while no timer runs.
3. Look for the icon alone. With no timer running, the item shows only the icon unless **When No Timer Runs** says otherwise.

## Privacy

The extension has no analytics and no tracking. It connects only to the server in **API URL** and opens pages of the web app in **Web App URL**.

Your session token is kept in Raycast's encrypted local storage. Cached data and waiting changes stay on this Mac.
