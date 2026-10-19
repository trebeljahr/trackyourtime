import type { Express } from "express";
import { API_V1_BASE_PATH } from "./api/v1/index.js";

/**
 * A small HTML page at the API host's root, so the host has something for a
 * person — or a URL-filter crawler — to read.
 *
 * Until this existed, `GET https://api.trackyourtime.dev/` answered the 404
 * handler's `{"error":"Not found"}`. Palo Alto's URL filtering files a host
 * like that under `insufficient-content` ("no content, provide API access not
 * intended for end-user display"), whose recommended action is Block, and a
 * corporate firewall that follows the recommendation refuses every tRPC call
 * while the web app itself loads. Palo Alto accepts no change requests for
 * that category: it is assigned from what the host serves, so the host has to
 * serve something. docs/deploy.md → "The API root page".
 *
 * Built once per app from FRONTEND_URL, never per request: no script, no
 * tracking, no request data, nothing a cache could leak between visitors.
 */

/** Where the docs live for every server — self-hosted ones serve none. */
const SITE_URL = "https://trackyourtime.dev/";
const API_REFERENCE_URL = "https://trackyourtime.dev/docs/api/reference/";
const REPO_URL = "https://github.com/trebeljahr/trackyourtime";

/** The live OpenAPI document of THIS server, relative so it is right anywhere. */
const OPENAPI_PATH = `${API_V1_BASE_PATH}/openapi.json`;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The page. Exported so a test reads exactly what is served.
 *
 * `frontendUrl` is this server's web app — `https://trackyourtime.dev` on the
 * hosted deploy, the self-hoster's own address elsewhere. An empty one (a dev
 * server with nothing set) drops that link rather than linking nowhere.
 */
export function apiRootHtml(frontendUrl: string): string {
  const appLink = frontendUrl
    ? `<li><a href="${escapeHtml(frontendUrl)}">Open the web app</a></li>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Track Your Time API</title>
<meta name="description" content="The API server for Track Your Time, an open-source time tracker.">
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; }
h1 { font-size: 1.5rem; }
li { margin: 0.25rem 0; }
</style>
</head>
<body>
<main>
<h1>Track Your Time API</h1>
<p>This address is the API server for <a href="${SITE_URL}">Track Your Time</a>, an open-source time tracker.
The web app, the desktop and phone apps and the browser extension load their data from here.
Integrations use the REST API under <code>${API_V1_BASE_PATH}</code> with an API token.</p>
<p>The apps cannot work without this address.
If a network filter blocks it, ask your administrator to allow it.</p>
<ul>
${appLink}
<li><a href="${API_REFERENCE_URL}">Read the API reference</a></li>
<li><a href="${OPENAPI_PATH}">Get the OpenAPI document</a></li>
<li><a href="${REPO_URL}">Read the source code</a></li>
</ul>
</main>
</body>
</html>
`;
}

/**
 * Mount the page at exactly `/`. Express answers HEAD from the GET route.
 *
 * Mounted after cors() and helmet(), so it carries the same headers as every
 * other response (helmet's CSP allows the inline `<style>` and nothing runs).
 * Traefik's drain probe is unaffected whatever path it uses: that middleware
 * is the first in `createApp` and answers before any route. Only GET and HEAD
 * of `/` match — an OPTIONS preflight is still cors()'s, and every other path
 * still reaches the 404 handler.
 */
export function registerApiRootRoute(app: Express, frontendUrl: string): void {
  const html = apiRootHtml(frontendUrl);
  app.get("/", (_req, res) => {
    res
      .status(200)
      .set("cache-control", "public, max-age=3600")
      .type("html")
      .send(html);
  });
}
