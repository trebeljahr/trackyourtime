/**
 * The `_redirects` and `_headers` the hosted Worker gets
 * (scripts/lib/cloudflare-static.mjs), checked against the rules serve.mjs
 * applies per request, plus the Workers Free limit check.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLimits, LIMITS, renderHeaders, renderRedirects } from "./cloudflare-static.mjs";
import { LEGACY_APP_SEGMENTS, legacyAppRedirect } from "../../packages/client/static-site-rules.mjs";

const rules = (text) => text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));

/** What Cloudflare does with a `_redirects` text, for the shapes rendered here: exact and `/*` → `:splat`. */
const applyRedirects = (text, url) => {
  const [path, query] = url.split("?");
  for (const line of rules(text)) {
    const [from, to, status] = line.split(/\s+/);
    if (from.endsWith("/*")) {
      const prefix = from.slice(0, -1);
      if (path.startsWith(prefix)) return { status: Number(status), location: to.replace(":splat", path.slice(prefix.length)) + (query ? `?${query}` : "") };
    } else if (path === from) {
      return { status: Number(status), location: to + (query ? `?${query}` : "") };
    }
  }
  return null;
};

describe("_redirects", () => {
  it("sends every legacy address where serve.mjs sends it", () => {
    const text = renderRedirects();
    for (const segment of LEGACY_APP_SEGMENTS) {
      for (const url of [`/${segment}/`, `/${segment}/sub/page/`, `/${segment}/?token=a&b=c`]) {
        assert.deepEqual(applyRedirects(text, url), { status: 308, location: legacyAppRedirect(url) }, url);
      }
      // serve.mjs answers the bare address with /app/<segment>, which the
      // static host then completes with a slash; the Worker goes there at once.
      assert.deepEqual(applyRedirects(text, `/${segment}`), { status: 308, location: `/app/${segment}/` });
    }
  });

  it("leaves everything else alone", () => {
    const text = renderRedirects();
    for (const url of ["/", "/app/track/", "/tracker/", "/docs/", "/de/", "/trackyourtime/"]) {
      assert.equal(applyRedirects(text, url), null, url);
    }
  });

  it("fits the dynamic-rule limit with room to spare", () => {
    const dynamic = rules(renderRedirects()).filter((line) => line.split(/\s+/)[0].includes("*"));
    assert.equal(dynamic.length, LEGACY_APP_SEGMENTS.length);
    assert.ok(dynamic.length <= LIMITS.dynamicRedirects);
  });
});

describe("_headers", () => {
  it("sends no-framing and no-sniffing on every path", () => {
    const text = renderHeaders();
    const all = text.slice(text.indexOf("/*\n"));
    assert.match(all, /^ {2}X-Frame-Options: DENY$/m);
    assert.match(all, /^ {2}Content-Security-Policy: frame-ancestors 'none'$/m);
    assert.match(all, /^ {2}X-Content-Type-Options: nosniff$/m);
  });

  it("marks the two deploy files no-cache and nothing immutable", () => {
    const text = renderHeaders();
    assert.match(text, /^\/version\.json\n {2}Cache-Control: no-cache$/m);
    assert.match(text, /^\/release-assets\.json\n {2}Cache-Control: no-cache$/m);
    // A 404 under /_next/static/ carries the rule too, and would be kept for a year.
    assert.doesNotMatch(text, /immutable|max-age=31536000/);
    assert.doesNotMatch(text, /^\/_next/m);
  });
});

describe("checkLimits", () => {
  it("passes a small export and reports its size", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-static-"));
    try {
      mkdirSync(join(dir, "_next", "static"), { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html></html>");
      writeFileSync(join(dir, "_next", "static", "a.js"), "x".repeat(10));
      const result = checkLimits(dir, { headers: renderHeaders(), redirects: renderRedirects() });
      assert.deepEqual(result.problems, []);
      assert.equal(result.files, 2);
      assert.equal(result.bytes, 23);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file over 25 MiB and too many rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-static-"));
    try {
      writeFileSync(join(dir, "big.zip"), Buffer.alloc(LIMITS.fileBytes + 1));
      const headers = Array.from({ length: 101 }, (_, i) => `/p${i}\n  X-A: b`).join("\n");
      const redirects = Array.from({ length: 101 }, (_, i) => `/p${i}/* /q${i}/:splat 301`).join("\n");
      const { problems } = checkLimits(dir, { headers, redirects });
      assert.equal(problems.length, 3);
      assert.match(problems[0], /big\.zip is \d+ bytes/);
      assert.match(problems[1], /_headers has 101 rules/);
      assert.match(problems[2], /_redirects has 101 dynamic rules/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
