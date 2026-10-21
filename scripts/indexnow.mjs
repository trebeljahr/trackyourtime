#!/usr/bin/env node
/** Preview public sitemap URLs locally; --submit verifies deployment before notifying IndexNow. */
import { readFile } from "node:fs/promises";

const origin = "https://trackyourtime.dev";
const out = new URL("../packages/client/out/", import.meta.url);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--submit") || args.length > 1) throw new Error("Usage: node scripts/indexnow.mjs [--submit]");
const key = (await readFile(new URL("../packages/client/public/indexnow-key.txt", import.meta.url), "utf8")).trim();
const xml = await Promise.all(["sitemap.xml", "docs/sitemap.xml"].map((path) => readFile(new URL(path, out), "utf8")));
const urls = [...new Set(xml.flatMap((text) => [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])))];
if (!/^[a-f0-9]{32}$/.test(key) || !urls.length || urls.length > 10_000) throw new Error("Invalid key or sitemap size");
for (const value of urls) {
  const url = new URL(value);
  if (url.origin !== origin || url.search || url.hash || !/^\/(?:de\/)?(?:$|[a-z][a-z0-9/-]*\/$)/.test(url.pathname)
    || /^\/(?:app|sub|login|signup|invite|forgot-password|reset-password)(?:\/|$)/.test(url.pathname)) {
    throw new Error(`Refusing non-public sitemap URL: ${value}`);
  }
}
console.log(`${urls.length} public sitemap URLs`);
if (!args.includes("--submit")) {
  console.log(urls.join("\n"));
  console.log("Preview only. After publishing, use --submit to verify live pages and notify IndexNow.");
} else {
  const keyLocation = `${origin}/indexnow-key.txt`;
  const proof = await fetch(keyLocation, { signal: AbortSignal.timeout(20_000) });
  if (!proof.ok || (await proof.text()).trim() !== key) throw new Error("Publish the matching IndexNow proof file first");
  // Small batches; new pages must be available before sending their URLs.
  for (let start = 0; start < urls.length; start += 4) {
    await Promise.all(urls.slice(start, start + 4).map(async (url) => {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const html = await response.text();
      if (response.status !== 200 || /noindex/i.test(response.headers.get("x-robots-tag") ?? "")
        || /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) {
        throw new Error(`Refusing unavailable or noindex page: ${url} (${response.status})`);
      }
    }));
  }
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(origin).host, key, keyLocation, urlList: urls }),
    signal: AbortSignal.timeout(30_000),
  });
  if (![200, 202].includes(response.status)) throw new Error(`IndexNow refused the notification: ${response.status} ${await response.text()}`);
  console.log(`IndexNow HTTP ${response.status}: ${response.status === 202 ? "received; key validation pending" : "received"}. Indexing is not guaranteed.`);
}
