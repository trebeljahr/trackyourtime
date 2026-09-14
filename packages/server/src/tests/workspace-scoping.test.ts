// The guard against the failure mode this whole re-architecture exists to
// prevent: a new router that scopes its queries by nothing.
//
// Authorization used to be a `{ ownerId }` literal repeated at ~180 query
// sites — a convention enforced by nothing. A resolver that forgot it did not
// throw; it returned somebody else's rows. Now there is exactly one way to be
// scoped (`workspaceProcedure`), and this test fails the build when a router
// does not use it.
//
// Deliberately a SOURCE-level assertion rather than a runtime one: it needs no
// database, no session and no tRPC internals, so it keeps working across
// upgrades and cannot itself be broken by a mocking mistake.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "trpc",
  "routers",
);

/**
 * Routers that are legitimately NOT workspace-scoped, each for a stated
 * reason. Adding a name here is a deliberate act; forgetting to scope a
 * router is not.
 */
const NOT_WORKSPACE_SCOPED: Record<string, string> = {
  "health.ts": "public liveness probe — no session at all",
  "profile.ts": "a profile belongs to the person, across every workspace",
  "devices.ts": "sessions belong to the person, not to a workspace",
  "billing.ts": "billing is per account, not per workspace",
  "workspaces.ts":
    "lists the person's workspaces and sets the session default — it is the question asked BEFORE a workspace is chosen",
};

/**
 * Routers that are workspace-scoped but also carry named procedures outside
 * any workspace, each for a stated reason. The file must still use
 * workspaceProcedure for everything else; only the procedures listed may use
 * protectedProcedure or publicProcedure.
 */
const MIXED_SCOPE: Record<string, { procedures: readonly string[]; reason: string }> = {
  "invitations.ts": {
    procedures: ["preview", "accept", "decline"],
    reason:
      "the invitee is not a member yet — accept/decline are authorized by the invitation id and the account's email, preview by the id alone",
  },
};

/** The procedure names in a router source that use `kind`. */
const proceduresUsing = (source: string, kind: string): string[] =>
  [...source.matchAll(new RegExp(`^\\s*(\\w+):\\s*${kind}\\b`, "gm"))].map((m) => m[1] ?? "");

/** Files that hold helpers rather than procedures. */
const NOT_A_ROUTER = new Set([
  "catalog-cascade.ts",
  "catalog-lookup.ts",
  "project-budgets.ts",
  "quick-start.ts",
]);

const routerFiles = readdirSync(ROUTERS_DIR).filter((f) => f.endsWith(".ts"));

const read = (file: string): string =>
  readFileSync(join(ROUTERS_DIR, file), "utf8");

test("there are routers to check", () => {
  assert.ok(routerFiles.length > 5, "expected the routers directory to be populated");
});

test("every domain router scopes its procedures with workspaceProcedure", () => {
  for (const file of routerFiles) {
    if (file in NOT_WORKSPACE_SCOPED || NOT_A_ROUTER.has(file)) continue;
    const source = read(file);
    if (!source.includes("Procedure")) continue;

    assert.ok(
      source.includes("workspaceProcedure"),
      `${file} defines procedures but never uses workspaceProcedure — ` +
        `it is unscoped. Use workspaceProcedure, or add it to ` +
        `NOT_WORKSPACE_SCOPED with the reason.`,
    );
  }
});

test("no domain router falls back to the unscoped protectedProcedure", () => {
  for (const file of routerFiles) {
    if (file in NOT_WORKSPACE_SCOPED || NOT_A_ROUTER.has(file)) continue;
    const source = read(file);
    const mixed = MIXED_SCOPE[file];
    if (mixed) {
      const unscoped = [
        ...proceduresUsing(source, "protectedProcedure"),
        ...proceduresUsing(source, "publicProcedure"),
      ].sort();
      assert.deepEqual(
        unscoped,
        [...mixed.procedures].sort(),
        `${file}: only ${mixed.procedures.join(", ")} may run outside a workspace`,
      );
      assert.ok(mixed.reason.length > 10);
      continue;
    }

    assert.ok(
      !source.includes("protectedProcedure"),
      `${file} uses protectedProcedure. That only proves a session exists — ` +
        `it ties the caller to no workspace, so every query underneath it is ` +
        `unscoped. Use workspaceProcedure.`,
    );
  }
});

test("no router still scopes by the removed ownerId field", () => {
  for (const file of routerFiles) {
    const source = read(file);
    assert.ok(
      !source.includes("ownerId"),
      `${file} references ownerId, which no longer exists on any document. ` +
        `A query filtering on it matches nothing (or, worse, everything).`,
    );
  }
});

test("the routers that opt out of workspace scoping each state why", () => {
  for (const [file, reason] of Object.entries(NOT_WORKSPACE_SCOPED)) {
    assert.ok(
      routerFiles.includes(file),
      `${file} is exempted from workspace scoping but no longer exists — ` +
        `drop it from NOT_WORKSPACE_SCOPED.`,
    );
    assert.ok(reason.length > 10, `${file} needs a real reason, not "${reason}"`);
  }
});

// A router can use `workspaceProcedure` and still be wrong: `ctx.user.id` is
// in scope beside `ctx.workspaceId`, and the two are interchangeable in a
// personal workspace, so a query keyed on the caller instead of the workspace
// matches today and returns nothing the day a workspace has a second member.
// `invoices.get` and `invoices.exportPdf` both did exactly that.
//
// Only the literal `workspaceId:` key is checked. Passing `ctx.user.id` as a
// separate argument — `ownWebhookFilter(ctx.workspaceId, ctx.user.id)` — is
// the deliberate within-workspace ownership check and stays legal.
test("no router uses the caller's user id as a workspace id", () => {
  for (const file of routerFiles) {
    const source = read(file);
    assert.ok(
      !/workspaceId:\s*ctx\.user\.id/.test(source),
      `${file} scopes a query with \`workspaceId: ctx.user.id\`. Those two ` +
        `values coincide only while every workspace is personal — use ` +
        `ctx.workspaceId. To restrict to what the CALLER owns within the ` +
        `workspace, add a separate field (createdBy/authorId/userId) beside ` +
        `ctx.workspaceId.`,
    );
  }
});
