#!/usr/bin/env node
// Serves the client's static export — in production inside the client image,
// and in the E2E suite, which delegates here rather than keeping a second
// implementation.
//
// The client is `output: "export"` (packages/client/next.config.ts), because
// the desktop and mobile shells load the same bundle from file:// and from the
// Capacitor container. That leaves no `.next/standalone` and no `server.js` to
// run, so the web deployment is a static file server over `out/`.
//
// One implementation for both callers on purpose: route resolution under
// `trailingSlash: true` is where the asset-path bugs live, and a prod server
// that resolved paths differently from the one E2E exercises would hide
// exactly those.
//
// Root is resolved relative to THIS FILE, not the working directory, so the
// repo layout (packages/client/serve.mjs -> packages/client/out) and the image
// layout (/app/serve.mjs -> /app/out) both work unchanged.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "out");
const PORT = Number(process.env.PORT ?? process.env.E2E_CLIENT_PORT ?? 6477);
// Containers must accept traffic from Traefik on another address; the E2E
// suite binds loopback so a run cannot be reached from off the machine.
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // The docs site writes a Markdown copy of every page (`/docs/mcp.md`) for AI
  // assistants; octet-stream would make a browser download it instead.
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
};

if (!existsSync(ROOT)) {
  console.error(`[serve] No static export at ${ROOT}. Run the client build first.`);
  process.exit(1);
}

/** Resolve a URL path to a file inside ROOT, or null if it escapes or is absent. */
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    // A malformed %-escape is a bad request, not a path to go looking for.
    return null;
  }

  // normalize() collapses "..", and the prefix check keeps the served tree
  // inside ROOT even if a request tries to climb out of it.
  const candidate = resolve(join(ROOT, normalize(decoded)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + "/")) return null;

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  // trailingSlash: true means routes are directories holding index.html.
  const asIndex = join(candidate, "index.html");
  if (existsSync(asIndex)) return asIndex;

  const asHtml = `${candidate}.html`;
  if (existsSync(asHtml)) return asHtml;

  return null;
}

/**
 * Cache headers by what the file is, not by how old it is.
 *
 * Everything under `/_next/static` carries a content hash in its name, so it
 * can be cached forever — a new build produces new names. So does everything
 * under `/docs/assets/`, where Docusaurus puts its hashed JS, CSS and images
 * (`/docs/img/` is copied from `static/` unhashed and keeps the hour). HTML
 * must not be, or a deploy leaves browsers pointing at chunk names that no
 * longer exist.
 */
function cacheControl(urlPath, file) {
  if (urlPath.startsWith("/_next/static/") || urlPath.startsWith("/docs/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (extname(file) === ".html") return "no-cache";
  return "public, max-age=3600";
}

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0];
  const file = resolveFile(req.url ?? "/");

  if (!file) {
    // The docs site (built into out/docs/ by scripts/docs/build-into-client.mjs)
    // has its own 404 page, with the docs navbar and sidebar around it.
    const docsNotFound = join(ROOT, "docs", "404.html");
    const notFound =
      (urlPath === "/docs" || urlPath.startsWith("/docs/")) && existsSync(docsNotFound)
        ? docsNotFound
        : join(ROOT, "404.html");
    const has404 = existsSync(notFound);
    res.writeHead(404, {
      "content-type": has404 ? MIME[".html"] : MIME[".txt"],
      "cache-control": "no-cache",
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    if (has404) createReadStream(notFound).pipe(res);
    else res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": cacheControl(urlPath, file),
    "content-length": statSync(file).size,
    // The export is same-origin static assets only; nothing here should be
    // framed or sniffed into another type.
    "x-content-type-options": "nosniff",
  });

  // HEAD must carry the headers and no body — piping would send one.
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[serve] Serving ${ROOT} on http://${HOST}:${PORT}`);
});

// Coolify and Docker stop containers with SIGTERM; without this the process
// ignores it and waits out the 10s kill timeout on every deploy.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
