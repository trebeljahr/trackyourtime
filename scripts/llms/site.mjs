/**
 * What an AI assistant is told about Track Your Time, in one place.
 *
 * Two `llms.txt` files are rendered from this module: trackyourtime.dev's
 * (`scripts/llms/build-llms.mjs`, committed under `packages/client/public/`)
 * and the docs site's (the `llms-markdown` plugin, written at build time).
 * They differ only in where their links point — the docs site is not deployed
 * yet, so the web app's copy links raw Markdown on GitHub — and keeping the
 * prose here stops the two from describing different products.
 *
 * Every sentence below has to be true of the repo on the day it is committed.
 * Change a limit here when the limit goes away, then run `pnpm llms:emit`.
 */

export const PRODUCT_NAME = "Track Your Time";
export const WEB_URL = "https://trackyourtime.dev";
export const API_URL = "https://api.trackyourtime.dev";
export const OPENAPI_URL = `${API_URL}/api/v1/openapi.json`;
export const REPO_URL = "https://github.com/trebeljahr/tracktime";
export const RAW_URL = "https://raw.githubusercontent.com/trebeljahr/tracktime/main";
export const BLOB_URL = `${REPO_URL}/blob/main`;

/**
 * Crawlers that fetch pages for AI assistants and AI search, allowed by name
 * in both robots files. A crawler that finds a group naming it ignores the
 * `User-agent: *` group, so the named group repeats the same rules.
 * `packages/client/src/app/robots.ts` keeps its own copy of this list, and
 * `scripts/lib/llms.test.mjs` fails when the two disagree.
 */
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "meta-externalagent",
  "Amazonbot",
  "DuckAssistBot",
  "cohere-ai",
];

/**
 * Docs pages by where they sit in `llms.txt`, keyed by Docusaurus doc id
 * (the path under `docs-site/docs/` without `.md`).
 *
 * `EXCLUDED_DOC_IDS` are left over from the starter this repo grew from and
 * describe a different product. They still get a `.md` copy on the docs site,
 * because every page does, but no `llms.txt` points an assistant at them.
 * A doc in none of these lists lands under "Optional", so a new page is never
 * silently missing.
 */
export const DOC_SECTIONS = [
  {
    title: "Start here",
    ids: ["intro", "choosing-a-self-hosted-time-tracker", "self-hosting"],
  },
  { title: "AI assistants", ids: ["mcp"] },
  { title: "REST API", ids: ["api/overview", "api/authentication", "api/errors"] },
];
export const OPTIONAL_DOC_IDS = ["api/reference", "api/webhooks", "api/rate-limits"];
export const EXCLUDED_DOC_IDS = ["getting-started", "architecture"];

/** The llms.txt header: H1, blockquote summary, and the facts an assistant needs. */
export function renderHeader() {
  return `# ${PRODUCT_NAME}

> Open-source time tracking you host on your own server. A timer in the browser, the Mac menu bar and a phone app keeps working offline, and tracked hours become reports and PDF invoices.

${PRODUCT_NAME} is for freelancers, consultants and small studios who bill clients by the hour and want that data on a server they control. The code is on GitHub at ${REPO_URL} under AGPL-3.0-or-later. A hosted instance runs at ${WEB_URL} and is free while in beta.

**What it does today**

- Your data stays on your server. One Docker Compose file runs five containers on one server and one domain: the API, the web app, MongoDB, Redis and Caddy. Caddy gets the HTTPS certificate from Let's Encrypt.
- You can export a whole workspace as JSON or CSV at any time. A CSV from another tool imports with a preview and a one-step undo.
- The timer is where you already work. There is a Chrome extension, a Raycast extension with a menu bar clock and a start/stop hotkey, and iPhone and Android apps.
- The web app, the extensions and the phone apps keep tracking without a connection. They send the queued changes when the connection returns.
- A timer you stop on one device stops on every other open device at once, over a WebSocket.
- Each project has an hourly rate. Reports show totals by project, client, task, tag, day, week or month, or list every entry. Both views export to CSV and PDF.
- An invoice collects a client's unbilled billable hours and downloads as a PDF. An hour on an invoice cannot be billed again.
- Every install has every feature. There are no paid plugins and no premium tier.
- The server has a REST API at \`/api/v1\` with an OpenAPI document, and sends webhooks signed with HMAC-SHA256.
- An MCP server lets an AI assistant start and stop timers, log past time and list entries. It also lists and creates clients, projects, tasks and tags, and reads summary reports. It runs from a clone of the repository and has no invoice tools.

**Current limits**

- The web app cannot invite team members. The data model has workspaces with members, but in practice each account is one private workspace.
- There is no tagged release yet, so there are no published images to pull. Until the first release, self-hosting means building the images yourself, which needs about 4 GB of RAM.
- A self-hosted instance has open sign-up. The application has no setting to close registration. The self-hosting guide lists workarounds at the proxy.
- The Chrome extension, the Raycast extension and the phone apps are not in any store yet.
- The Chrome extension has its server address compiled in. To use it with your own server, edit \`packages/extension/manifest.config.ts\` and build it.
- The Raycast extension has API URL and Web App URL preferences, so one build reaches any server.
- The phone apps connect only to the hosted service. On your own server, use the web app in the phone's browser.

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
