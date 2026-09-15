/**
 * The invitation link is `/invite/?id=…`, and two innocent-looking refactors
 * break every link already sent:
 *
 *  - a dynamic `/invite/[id]` segment, which `output: "export"` cannot serve
 *    for ids that did not exist at build time (every one of them 404s), and
 *  - moving the page under `app/app/`, where a signed-out visitor is sent
 *    to /login before the page can say what they were invited to.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("..", import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [];
  });

describe("the invite route", () => {
  it("is a public page at app/invite/page.tsx", () => {
    expect(existsSync(join(appDir, "invite", "page.tsx"))).toBe(true);
    expect(existsSync(join(appDir, "app", "invite"))).toBe(false);
  });

  it("has no dynamic segment anywhere under an invite directory", () => {
    const offenders = walk(appDir).filter(
      (path) => /[/\\]invite[/\\]/.test(`${path}/`) && /\[[^\]]+\]/.test(path),
    );
    expect(offenders).toEqual([]);
  });
});
