import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { apiRootHtml } from "../api-root.js";
import { createApp } from "../app.js";
import { env } from "../config/env.js";

const WEB = "https://web.api-root.test";

// The API host's root page exists so URL filters stop filing the host as
// "insufficient-content" (docs/deploy.md → "The API root page"). These pin
// that it is a real page, and that it took nothing from the routes around it.
describe("API root page", () => {
  let server: Server;
  let base: string;
  const previous = { FRONTEND_URL: env.FRONTEND_URL, TRUSTED_ORIGINS: env.TRUSTED_ORIGINS };

  before(async () => {
    Object.assign(env, { FRONTEND_URL: WEB, TRUSTED_ORIGINS: "" });
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    Object.assign(env, previous);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves an HTML page naming the product and linking the docs", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    const html = await response.text();
    assert.match(html, /<title>Track Your Time API<\/title>/);
    assert.match(html, /<h1>Track Your Time API<\/h1>/);
    assert.ok(html.includes('href="https://trackyourtime.dev/"'));
    assert.ok(html.includes('href="https://trackyourtime.dev/docs/api/reference/"'));
    assert.ok(html.includes('href="/api/v1/openapi.json"'));
    assert.ok(html.includes(`href="${WEB}"`), "links this server's own web app");
    assert.doesNotMatch(html, /<script/i);
  });

  it("answers HEAD without a body", async () => {
    const response = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), "");
  });

  it("leaves Traefik's drain probe answering first, on the root too", async () => {
    const response = await fetch(`${base}/`, { headers: { "x-hatchkit-drain": "1" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "serving\n");
  });

  it("leaves a preflight to cors() and every other path to the 404 handler", async () => {
    const preflight = await fetch(`${base}/`, {
      method: "OPTIONS",
      headers: { origin: WEB, "access-control-request-method": "GET" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), WEB);
    assert.equal(await preflight.text(), "");

    for (const path of ["/index.html", "/api", "/nope"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { error: "Not found" }, path);
    }
  });

  it("escapes the web app address and drops the link when there is none", () => {
    assert.ok(apiRootHtml('https://x.test/"><b>').includes('href="https://x.test/&quot;&gt;&lt;b&gt;"'));
    assert.doesNotMatch(apiRootHtml(""), /Open the web app/);
  });
});
