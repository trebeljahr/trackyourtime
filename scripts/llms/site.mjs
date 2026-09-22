/**
 * What an AI assistant is told about Track Your Time, in one place.
 *
 * Two `llms.txt` files are rendered from this module: trackyourtime.dev's
 * (`scripts/llms/build-llms.mjs`, committed under `packages/client/public/`)
 * and the docs site's (the `llms-markdown` plugin, written at build time).
 * Both link the docs pages' Markdown copies under trackyourtime.dev/docs/;
 * they differ in which other pages they list. Keeping the prose here stops the
 * two from describing different products.
 *
 * Every sentence below has to be true of the repo on the day it is committed.
 * Change a limit here when the limit goes away, then run `pnpm llms:emit`.
 */

export const PRODUCT_NAME = "Track Your Time";
export const WEB_URL = "https://trackyourtime.dev";
/** The docs site, served from the web app's image. Must match docs-site/docusaurus.config.ts. */
export const DOCS_URL = `${WEB_URL}/docs`;
export const API_URL = "https://api.trackyourtime.dev";
export const OPENAPI_URL = `${API_URL}/api/v1/openapi.json`;
export const REPO_URL = "https://github.com/trebeljahr/trackyourtime";
export const RAW_URL = "https://raw.githubusercontent.com/trebeljahr/trackyourtime/main";
export const BLOB_URL = `${REPO_URL}/blob/main`;

/**
 * Docs pages by where they sit in `llms.txt`, keyed by Docusaurus doc id
 * (the path under `docs-site/docs/` without `.md`).
 *
 * `EXCLUDED_DOC_IDS` still get a `.md` copy on the docs site, because every
 * page does, but no `llms.txt` points an assistant at them. A doc in none of
 * these lists lands under "Optional", so a new page is never silently missing.
 */
export const DOC_SECTIONS = [
  {
    title: "Start here",
    ids: ["intro", "choosing-a-self-hosted-time-tracker", "self-hosting"],
  },
  { title: "Invoicing", ids: ["e-invoices"] },
  { title: "Apps", ids: ["desktop"] },
  { title: "AI assistants", ids: ["mcp"] },
  { title: "REST API", ids: ["api/overview", "api/authentication", "api/errors"] },
];
export const OPTIONAL_DOC_IDS = ["api/reference", "api/webhooks", "api/rate-limits"];
export const EXCLUDED_DOC_IDS = [];

/** The llms.txt header: H1, blockquote summary, and the facts an assistant needs. */
export function renderHeader() {
  return `# ${PRODUCT_NAME}

> Free, open-source time tracking. Use the hosted service at trackyourtime.dev, or run the same app on your own server. A timer in the browser, the Mac menu bar and a phone app keeps working offline and syncs across devices, and tracked hours become reports and invoices: a plain PDF, a ZUGFeRD PDF or an XRechnung file.

${PRODUCT_NAME} is for freelancers, consultants and small studios who bill clients by the hour. The code is on GitHub at ${REPO_URL} under AGPL-3.0-or-later. A hosted instance runs at ${WEB_URL}. It is free, has no paid plan, and runs the same code as a self-hosted server.

**What it does today**

- Your data can stay on your own server. One Docker Compose file runs five containers on one server and one domain: the API, the web app, MongoDB, Redis and Caddy. Caddy gets the HTTPS certificate from Let's Encrypt.
- You can export a whole workspace as JSON or CSV at any time. A CSV from another tool imports with a preview and a one-step undo.
- The timer is where you already work. There is a Chrome extension, a Raycast extension with a menu bar clock and a start/stop hotkey, and iPhone and Android apps.
- The web app, the extensions and the phone apps keep tracking without a connection. They send the queued changes when the connection returns.
- Every client app works with the hosted service and with a self-hosted server. The Chrome extension and the phone apps let the person choose a server before signing in, and a self-hosted server accepts their store builds by default (\`TRUST_STORE_APPS=true\`). The Raycast extension has API URL and Web App URL preferences.
- Recent entries, pinned favorites and description autocomplete fill in earlier details. A maximum timer length stops a forgotten timer or emails a reminder. The Chrome extension can suggest entries from browsing activity, off by default and kept on the computer until a suggestion is accepted.
- Workspaces have members, email or link invitations, three roles (owner, admin, member) and per-member visibility of colleagues' time and money. Reports group by member.
- Projects can carry a budget in hours or money, shown as progress.
- Settings → Data → Move to another server copies a workspace between two servers, hosted to self-hosted or back.
- A timer you stop on one device stops on every other open device at once, over a WebSocket.
- Each project has an hourly rate. Reports show totals by project, client, task, tag, day, week or month, or list every entry. Both views export to CSV and PDF.
- An invoice collects a client's unbilled billable hours. It downloads as a plain PDF, as a ZUGFeRD PDF or as an XRechnung XML file. An hour on an invoice cannot be billed again.
- Every install has every feature. There are no paid plugins and no premium tier.
- The server has a REST API at \`/api/v1\` with an OpenAPI document, and sends webhooks signed with HMAC-SHA256.
- An MCP server lets an AI assistant start and stop timers, log past time and list entries. It also lists and creates clients, projects, tasks and tags, and reads summary reports. It runs from a clone of the repository and has no invoice tools.

**Current limits**

- Rates belong to projects and the workspace, not to people. Everyone in a workspace bills a project at the same rate.
- There is no timesheet approval, no client login or shared report link, and no budget alert.
- There is no tagged release yet, so there are no published images to pull. Until the first release, self-hosting means building the images yourself, which needs about 4 GB of RAM.
- A self-hosted instance has open sign-up. The application has no setting to close registration. The self-hosting guide lists workarounds at the proxy.
- The Chrome extension is in the Chrome Web Store (https://chromewebstore.google.com/detail/track-your-time/opibnndhibnigcfgfbgbipakadhnbjfi). The Raycast extension and the phone apps are not in any store yet.

**How to self-host**

Point a domain at a Linux server with Docker, clone the repository, copy \`.env.selfhost.example\` to \`.env\`, and set \`APP_DOMAIN\` and \`BETTER_AUTH_SECRET\`. Then run \`docker compose -f docker-compose.selfhost.yml up -d\`. The self-hosting guide below has every command, the expected output, backups, upgrades and troubleshooting.
`;
}

/**
 * A full llms.txt: the header, then one H2 file list per section.
 *
 * @param {Array<{ title: string, links: Array<{ title: string, url: string, description?: string }> }>} sections
 * @returns {string}
 */
export function renderLlmsTxt(sections) {
  const lists = sections
    .filter((section) => section.links.length > 0)
    .map(
      (section) =>
        `## ${section.title}\n\n${section.links
          .map((link) => `- [${link.title}](${link.url})${link.description ? `: ${link.description}` : ""}`)
          .join("\n")}\n`,
    );
  return `${renderHeader()}\n${lists.join("\n")}`;
}

/**
 * The llms-full.txt shape: the llms.txt content, then each page's Markdown
 * under a rule and its source address.
 *
 * @param {string} llmsTxt
 * @param {Array<{ url: string, markdown: string }>} pages
 * @returns {string}
 */
export function renderLlmsFull(llmsTxt, pages) {
  const bodies = pages.map((page) => `---\n\nSource: ${page.url}\n\n${page.markdown.trim()}\n`);
  return `${llmsTxt.trim()}\n\n${bodies.join("\n")}`;
}
