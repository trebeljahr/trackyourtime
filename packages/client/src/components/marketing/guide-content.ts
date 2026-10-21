import type { Locale } from "@/i18n/marketing";
import { GERMAN_GUIDES } from "./guide-content-de";

export type GuideSection = {
  title: string;
  paragraphs?: readonly string[];
  steps?: readonly string[];
  code?: string;
  links?: readonly { label: string; href: string }[];
};
export type Guide = {
  title: string;
  description: string;
  intro: string;
  shot?: "web-track" | "web-reports" | "web-invoice" | "phone-track";
  sections: readonly GuideSection[];
  related: readonly string[];
};

const docs = "https://trackyourtime.dev/docs/";

// Each page answers a distinct working problem. Examples use synthetic data.
export const GUIDES: Record<Locale, Record<string, Guide>> = {
  en: {
    "self-hosting": {
      title: "Self-hosted time tracking with Docker Compose",
      description: "Keep client names, tracked hours and invoices on your own server. Requirements, installation, backups and the limits to check first.",
      intro: "Your time tracker holds client names, rates and a record of each working day. Run the same app on a server you control.",
      shot: "web-track",
      sections: [
        { title: "Check the server before you start", paragraphs: ["Use Linux, Docker Engine with Compose v2, a domain and reachable ports 80 and 443. Published images support amd64 and arm64.", "Plan for 1–2 GB of RAM, one CPU core and at least 5 GB of disk plus backups. These are sizing guidelines, not benchmarks.", "Pulling published images needs no source build. Building them yourself needs about 4 GB of RAM or RAM plus swap."] },
        { title: "One stack, one domain", paragraphs: ["The compose file runs the API, web app, MongoDB, Redis and Caddy. MongoDB runs as a single-node replica set.", "Caddy handles HTTPS when DNS and ports are ready. An existing reverse proxy needs its own routing and certificate setup.", "Keep one API replica. Live updates do not fan out between separate server processes."], links: [{ label: "Follow the complete installation guide", href: docs + "self-hosting/" }] },
        { title: "Install and verify", steps: ["Point your domain at the server before starting the stack.", "Clone the repository and copy .env.selfhost.example to .env.", "Set APP_DOMAIN and generate BETTER_AUTH_SECRET on the server. Keep secrets out of chats and logs.", "Start the compose stack, wait for healthy services, then run the documented selfhost-check.sh command.", "Create your account and test a time entry before inviting colleagues."], code: "docker compose -f docker-compose.selfhost.yml pull\ndocker compose -f docker-compose.selfhost.yml up -d", links: [{ label: "Source and compose file", href: "https://github.com/trebeljahr/trackyourtime" }] },
        { title: "Keep the installation usable", paragraphs: ["Back up MongoDB and the persistent files described in the guide. Store a copy away from the server and test a restore.", "Read the upgrade notes before changing the image tag. Take a backup before each upgrade.", "SMTP is optional, but account mail needs it. Without mail, use the administrator tools for account recovery.", "Registration is open by default. Restrict it at your proxy if the instance is private."], links: [{ label: "Backups and upgrades", href: docs + "self-hosting/#backup-and-restore" }] },
        { title: "Let an assistant follow the guide", paragraphs: ["Give it access to your server and an existing DNS record. Enter SMTP credentials on the server yourself."], code: "Set up Track Your Time on my Ubuntu server at <domain>, following https://trackyourtime.dev/docs/self-hosting/. Keep secrets on the server. Run scripts/selfhost-check.sh <domain> at the end and show its output." },
      ], related: ["guides/move-server", "api", "offline"],
    },
    api: {
      title: "Time tracking API, webhooks and MCP",
      description: "Connect timers and time entries to your own tools. Start with scoped API tokens, the REST reference, OpenAPI and signed webhooks.",
      intro: "Log time from a script, build a report, or let an assistant operate a timer. Use the same permissions as your account.",
      sections: [
        { title: "Start with a token that can only read", steps: ["Open Settings → API tokens in your workspace.", "Choose the smallest scopes your integration needs.", "Store the token outside source control. Send it as a Bearer token to your server’s /api/v1 routes.", "Read /me first to check the account and workspace before writing entries."], code: 'curl "$TRACKYOURTIME_API_URL/api/v1/me" \\\n  -H "Authorization: Bearer $TRACKYOURTIME_API_TOKEN"', links: [{ label: "Authentication and scopes", href: docs + "api/authentication/" }, { label: "Download OpenAPI JSON", href: docs + "openapi.json" }] },
        { title: "Use entries, timers and catalogs", paragraphs: ["REST reads and writes entries, clients, projects, tasks and tags. Summary reports expose totals when your token can see money.", "List routes use cursor pagination. Errors return application/problem+json. Handle rate limits and refusals before retrying writes.", "The public REST API has no invoice, CSV-export or PDF-export routes. Use the web app for those."], links: [{ label: "Every route and schema", href: docs + "api/reference/" }, { label: "Errors and rate limits", href: docs + "api/errors/" }] },
        { title: "Receive changes instead of polling", paragraphs: ["Webhooks report entry, timer, catalog and invoice changes. Verify the timestamp and HMAC-SHA256 signature against the unchanged request body.", "Use an HTTPS receiver. Make duplicate deliveries harmless and check the delivery history when an event does not arrive."], links: [{ label: "Webhook events and signature verification", href: docs + "api/webhooks/" }] },
        { title: "Give an assistant bounded access", paragraphs: ["The MCP server runs locally over stdio and calls the REST API. It can operate timers, log time, manage catalogs and read summary reports.", "Its tools follow token scopes. It has no invoice tools. Review any assistant’s write requests before allowing changes."], links: [{ label: "MCP setup and supported tools", href: docs + "mcp/" }] },
      ], related: ["developers", "self-hosting", "time-reports"],
    },
    invoicing: {
      title: "Turn tracked hours into invoices",
      description: "Create PDF, ZUGFeRD or XRechnung invoices from unbilled time. Keep historical rates, review client details and record payments.",
      intro: "Finish the month without copying hours into another document. Select a client and a period, then review the unbilled work.",
      shot: "web-invoice",
      sections: [
        { title: "Prepare the details once", steps: ["Fill in your business profile, address, tax details and payment details.", "Add the client’s billing name and address. Choose the invoice language.", "Set a project or member rate before tracking. Entries keep the rate and currency captured when they were created.", "Check billable flags, dates and amounts before creating the invoice."], paragraphs: ["A later rate change does not rewrite old hours. For example, two hours saved at €60 remain €120 after you raise the rate."] },
        { title: "Bill each hour once", paragraphs: ["The invoice collects eligible, unbilled entries for the client and period. Included entries are locked against changes that would alter the invoice.", "Review the draft and download the format your client needs. A PDF export does not send an email to your client.", "Record payments and credits to see the amount still owed. Use the overdue filter when checking unpaid invoices."] },
        { title: "Choose the file the recipient accepts", paragraphs: ["Plain PDF works for a human reader. ZUGFeRD combines a readable PDF with structured invoice data. XRechnung exports XML.", "Required fields depend on the format and recipient. Fill in buyer references and tax details before exporting.", "These exports are not a certification or a guarantee of acceptance. Check your recipient’s requirements."], links: [{ label: "Fields and checks for German e-invoices", href: docs + "e-invoices/" }, { label: "Make a single PDF without an account", href: "/invoice-generator/" }] },
      ], related: ["freelancers", "time-reports", "studios"],
    },
    offline: {
      title: "Offline time tracking across your devices",
      description: "See what stays on the device, when queued changes sync, and how to protect unsent hours on the web, phone, desktop, extension and Raycast.",
      intro: "A dropped connection should not erase the work you track. Time-entry changes wait on the device until your server can accept them.",
      shot: "phone-track",
      sections: [
        { title: "Sign in before you lose signal", paragraphs: ["Use the app online first so it knows your account, workspace and recent entries. A first sign-in still needs a connection.", "Start and stop timers without a connection. Existing cached data stays available. Other devices only see changes after they reach the server.", "Offline support covers time-entry work. Do not assume every catalog, report or invoice operation works without the server."] },
        { title: "Know when each client sends the queue", paragraphs: ["The web app, desktop app, phone and browser extension retry when connected and active. Open the app if changes still wait.", "Raycast drains its queue during reads and reconnects. Its menu-bar refresh can trigger a retry. Open a command after reconnecting.", "A running phone timer is saved locally so it can reappear after an offline restart. The app does not need to remain open to measure elapsed time."] },
        { title: "Keep the only copy of unsent work", steps: ["Check the waiting-change count before signing out, changing servers or uninstalling.", "Reconnect to the account, workspace and server that created the changes.", "If the session expired, sign in again. A rejected login does not erase the queue.", "Review held or refused changes before discarding them. Do not clear browser or app storage while changes wait."], paragraphs: ["The Chrome extension and Raycast keep queued entries across sign-out. Another account does not receive those entries.", "Device storage can still be lost or cleared. Offline storage is not a backup."] },
      ], related: ["guides/offline-phone", "mobile", "support"],
    },
    "time-reports": {
      title: "Time reports with CSV and PDF export",
      description: "Filter tracked hours, group them by client or task, save report views, and export the selected period to CSV or PDF.",
      intro: "Find which work used the month, then send the same filtered result to your accountant or client.", shot: "web-reports",
      sections: [
        { title: "Ask one question at a time", steps: ["Choose the date range before comparing totals.", "Filter to the client, project, task, tag or member you need.", "Group by client for billing, by task for repeated work, or by day, week or month for trends.", "Open the entries behind a group to inspect unexpected totals. Save a named view for a report you repeat."], paragraphs: ["Tasks are independent of projects. One ‘Design review’ task can collect hours across several clients without making a copy for each project."] },
        { title: "Keep hours and money distinct", paragraphs: ["Reports use the rate and currency stored with each entry. Changing a current project rate does not recalculate historical earnings.", "Colleagues’ time and money follow workspace visibility permissions. A report cannot reveal money your account cannot see.", "Project budgets show progress in hours or money. There are no budget alerts or public client report links."] },
        { title: "Export the selected report", paragraphs: ["CSV gives you data for a spreadsheet. PDF gives you a document you can send. Both cover the full selected range.", "A report is a record of work, not an invoice. Create an invoice separately when you need to bill eligible hours."], links: [{ label: "Bill the hours in an invoice", href: "/invoicing/" }] },
      ], related: ["freelancers", "studios", "import-csv"],
    },
    freelancers: {
      title: "Time tracking for freelancers who bill by the hour",
      description: "A practical workflow from client setup to a checked invoice, with historical rates, reports and an export you can keep.",
      intro: "A client asks what the month cost. You need hours you can explain and an invoice that agrees with them.", shot: "web-track",
      sections: [
        { title: "Start with one client and one project", steps: ["Create the client with the billing details you use on invoices.", "Add a project with its agreed rate and currency. Add an hours or money budget if the agreement has a cap.", "Name repeated work as a task. Use the same task across projects when you want to compare it later.", "Track a short example entry and check its amount before using the setup for real work."] },
        { title: "Close the day while you remember it", paragraphs: ["Continue recent work instead of retyping it. Use the weekly timesheet or calendar to correct gaps.", "Set a maximum timer length if forgotten timers are a problem. Email reminders remain off until you choose them.", "Before a trip, open the app online. After the trip, check that queued hours reached the server."], links: [{ label: "What works offline", href: "/offline/" }] },
        { title: "Check the month before sending a bill", steps: ["Filter a report to the client and invoice period.", "Inspect unbillable time and entries with missing or unexpected rates.", "Review the business profile and client address, then create the invoice from unbilled entries.", "Download the required file, send it yourself and record payments when they arrive."], links: [{ label: "Invoice workflow and file formats", href: "/invoicing/" }] },
        { title: "Decide where the records live", paragraphs: ["The hosted version is free. Self-hosting offers the same features, but you maintain backups, mail and upgrades.", "Keep JSON exports for a workspace transfer and CSV for spreadsheets. Clients cannot sign in to view a shared report."] },
      ], related: ["invoicing", "time-reports", "self-hosting"],
    },
    studios: {
      title: "Time tracking for small studios and agencies",
      description: "Set up team workspaces, visibility, rates and timesheet approvals before turning shared project work into reports and invoices.",
      intro: "Several people work on the same client. Keep their hours together without making everyone’s rates visible to the whole team.", shot: "web-reports",
      sections: [
        { title: "Keep team work separate from personal work", steps: ["Create a team workspace. A personal workspace cannot be shared.", "Add clients and projects before inviting colleagues, so everyone uses the same names.", "Invite members by email or link. Choose owner, admin or member roles deliberately.", "Set each member’s visibility of colleagues’ hours and money. Test with a member account before relying on the setup."] },
        { title: "Agree on rates before logging work", paragraphs: ["An entry uses the project rate first, then the member rate, then the workspace default. Check this order against your client agreement.", "Rates are saved with entries. Raising a rate does not rewrite the previous month.", "A task can span projects. Tags help separate recurring work without duplicating the task list."] },
        { title: "Review a period before billing", paragraphs: ["Enable timesheet approval when your team needs it. Members submit periods, and an owner or admin approves them.", "Submitted and approved periods lock time-entry changes. Resolve corrections through the approval workflow before changing the underlying hours.", "Group reports by member to review contributions, then by client for billing. Export CSV or PDF for the selected range."] },
        { title: "Check the limits against your workflow", paragraphs: ["There is no client portal, shared report link or budget alert. Send documents to clients yourself.", "Self-hosting uses one API replica. Keep backups and upgrades under a named person’s care.", "There is no screenshot or keystroke monitoring. Optional activity capture stays on each person’s computer until they accept an entry."] },
      ], related: ["time-reports", "invoicing", "self-hosting"],
    },
    developers: {
      title: "Time tracking for developers and their tools",
      description: "Choose between a browser timer, Raycast and an API integration. Check permissions, offline behavior and self-hosting before connecting tools.",
      intro: "Start a timer without changing the work in front of you. Automate the repetitive parts only after you can inspect what they write.",
      sections: [
        { title: "Choose the smallest integration", paragraphs: ["Use the Chrome extension for a toolbar timer. Use the desktop app for a shortcut from another application.", "Raycast offers timer, entries, menu-bar, toggle-timer and open-dashboard commands. It stays English and is not in the Raycast Store yet.", "A script can use REST. An assistant can use the local MCP server with a scoped token."], links: [{ label: "REST, webhooks and MCP", href: "/api/" }, { label: "Raycast setup", href: "/raycast/" }] },
        { title: "Keep automation accountable", steps: ["Start with read scopes and a synthetic entry in a test workspace.", "Check /me before writing to confirm the target account and workspace.", "Handle pagination, rate limits and API errors. Do not retry a refused write forever.", "Verify webhook signatures and make repeated deliveries harmless.", "Revoke the token when the integration is no longer needed."] },
        { title: "Use your own server without rebuilding clients", paragraphs: ["Choose your server before signing in to the phone, desktop or extension. Raycast uses API URL and Web App URL preferences.", "Queued time belongs to the original account, workspace and server. Finish syncing before switching targets.", "Reports and invoices remain available in the web app. The public REST API and MCP server have no invoice-export tools."], links: [{ label: "Server requirements and installation", href: "/self-hosting/" }] },
      ], related: ["api", "offline", "self-hosting"],
    },
    "import-csv": {
      title: "Bring your tracked history from a CSV export",
      description: "Prepare columns and dates, inspect the import preview, check totals and undo a batch without naming a particular source tool.",
      intro: "Keep your old hours when you change trackers. Import the file into a test workspace first and compare totals before relying on it.",
      sections: [
        { title: "Prepare a file the preview can explain", paragraphs: ["The importer matches column names and values. It does not choose a parser by the exporting product’s name.", "Use start and end timestamps, a date with start and end times, or a date with a duration. Extra columns can describe the work.", "Comma and semicolon files are supported. Duration values can use dot or comma decimals. Keep the original export unchanged as a backup."], code: "Date,Start,End,Description,Client,Project,Task\n2026-10-01,09:00,10:30,Design review,Example client,Website,Review" },
        { title: "Check columns and date order", steps: ["Open Settings → Data and choose the CSV file.", "Inspect the detected columns. Correct any role that does not match your data.", "Check day/month order. A date such as 03/04 is ambiguous until the file or your selection resolves it.", "Read skipped rows and warnings before saving.", "Compare the preview’s daily totals with the original export."], paragraphs: ["If a file has only dates and durations, entries receive consecutive times within each day. Those clock times were not recorded by the source."] },
        { title: "Verify the saved batch and keep a way back", paragraphs: ["Import a small sample first. Check the first day, last day, hours, currency and catalog names.", "The importer records a batch you can undo. Undo removes catalog items it created only when nothing else uses them.", "A batch with entries on an invoice cannot be undone. Check the import before billing those hours.", "For a move between Track Your Time servers, use JSON and the server-move workflow instead of CSV."], links: [{ label: "Move a workspace between servers", href: "/guides/move-server/" }] },
      ], related: ["guides/move-server", "time-reports", "self-hosting"],
    },
    "guides/offline-phone": {
      title: "Track time on a phone with no signal",
      description: "Prepare before a trip, use the phone timer offline, and verify queued entries after the connection returns.",
      intro: "A train, a site visit or a tunnel can cut your connection. Prepare once online, then check the queue when you reconnect.", shot: "phone-track",
      sections: [
        { title: "Before you leave", steps: ["Sign in and choose the correct server and workspace while online.", "Open the tracker and recent entries so the device has the data you need.", "Check that no previous changes are waiting. Avoid an app reinstall or storage clear before the trip."], paragraphs: ["The native iPhone and Android builds are not in public stores yet. Follow the mobile page for current availability."] },
        { title: "While you have no signal", paragraphs: ["Start and stop the timer or add time manually. The phone saves time-entry changes on the device before sending them.", "A locally saved timer restores after an offline app restart. Elapsed time does not require the app to run continuously.", "The native app stores the queue and running timer in device preferences. Clearing app data or uninstalling can still erase the only copy.", "Other devices cannot see this work until it syncs. Reports and invoices that need fresh server data can wait."] },
        { title: "When the connection returns", steps: ["Open or resume the app while signed in to the original account and server.", "Let the waiting-change count reach zero before changing servers or removing the app.", "Inspect the resulting entries and stop any timer you meant to finish.", "If sign-in expired, sign in again. Review a held change before discarding it."], links: [{ label: "Offline behavior across every client", href: "/offline/" }, { label: "Phone builds and availability", href: "/mobile/" }] },
      ], related: ["offline", "mobile", "support"],
    },
    "guides/move-server": {
      title: "Move tracked work to your own server",
      description: "Copy a workspace between hosted and self-hosted Track Your Time, check totals, and keep the source intact until the transfer is verified.",
      intro: "Change where your records live without reconstructing each entry. The move copies a workspace, so keep the source until you verify the result.",
      sections: [
        { title: "Prepare the target and a backup", steps: ["Finish syncing pending changes on every source device.", "Export JSON from Settings → Data and keep it outside the source server.", "Install and check the destination server. Create an account and an empty target workspace.", "Record the source entry count and total hours for a fixed date range."], paragraphs: ["JSON preserves catalog details that CSV does not. The move is not a database clone: accounts, sessions and issued invoices need separate care."] },
        { title: "Use Settings → Data → Move to another server", paragraphs: ["Sign in to both servers through the move flow and select the target workspace. Review its identity before importing.", "A direct move works only when the target trusts the web app’s origin. Otherwise download the parts and import them on the target’s own Settings → Data.", "Large histories are split into parts. Restore workspace settings only into an empty workspace, using the first part. Pinned quick starts also use the first part."] },
        { title: "Verify before switching devices", steps: ["Check that imported plus already-present entries equal the exported count.", "Compare first and last dates, hours, rates, currency, clients and projects.", "Create a test entry on the new server and verify it from another signed-in device.", "Change each client’s server only after its old queue is empty.", "Keep the original server and export until your own retention decision allows removal."], paragraphs: ["A stopped move can be resumed. Inspect already-present counts and warnings rather than assuming every retry imports new entries.", "Keep issued invoice files and original backups separately. Do not treat an entry transfer as a transfer of every server record."], links: [{ label: "Prepare a self-hosted server", href: "/self-hosting/" }, { label: "Importing a CSV from another tool", href: "/import-csv/" }] },
      ], related: ["self-hosting", "import-csv", "offline"],
    },
  },
  de: GERMAN_GUIDES,
};
