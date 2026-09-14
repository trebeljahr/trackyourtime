/**
 * better-auth's organization endpoints are closed to HTTP.
 *
 * Runs the real library (in-memory adapter, as in
 * account-deletion-integration.test.ts) with the SAME `hooks.before` and
 * organization options `auth/auth.ts` wires in. Every plugin endpoint, hit
 * with a real `Request` carrying a valid bearer session, must answer exactly
 * what an unmounted route answers — 404 — and must write nothing. Server-side
 * `auth.api.*` calls, which carry no request, must still work: that is how
 * every personal workspace gets created.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import { organization } from "better-auth/plugins/organization";

import {
  authBeforeHook,
  isOrganizationHttpRequest,
  organizationPluginOptions,
} from "../services/membership/organization-lockdown.js";
import {
  authMembershipStore,
  type MembershipAuthAdapter,
} from "../services/membership/stores.js";

type Row = Record<string, unknown> & { id: string };
type MemoryDb = Record<
  "user" | "session" | "account" | "verification" | "organization" | "member" | "invitation",
  Row[]
>;

const BASE = "http://localhost:3000";

let db: MemoryDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

beforeEach(() => {
  db = { user: [], session: [], account: [], verification: [], organization: [], member: [], invitation: [] };
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: "organization-lockdown-integration-secret-0123456789",
    baseURL: BASE,
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password: string) => `plain:${password}`,
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          hash === `plain:${password}`,
      },
    },
    hooks: { before: authBeforeHook },
    plugins: [bearer(), organization(organizationPluginOptions)],
  });
});

async function signUp(name: string): Promise<{ id: string; token: string }> {
  const response = await auth.api.signUpEmail({
    body: { email: `${name}@example.com`, password: "correct horse battery", name },
    returnHeaders: true,
  });
  const token = response.headers.get("set-auth-token");
  assert.ok(token);
  return { id: response.response.user.id, token };
}

/** Every endpoint the plugin mounts (teams are off, but listed anyway). */
const ORGANIZATION_PATHS = [
  "accept-invitation", "add-team-member", "cancel-invitation", "check-slug", "create",
  "create-role", "create-team", "delete", "delete-role", "get-active-member",
  "get-active-member-role", "get-full-organization", "get-invitation", "get-role",
  "has-permission", "invite-member", "leave", "list", "list-invitations", "list-members",
  "list-roles", "list-team-members", "list-teams", "list-user-invitations",
  "list-user-teams", "reject-invitation", "remove-member", "remove-team",
  "remove-team-member", "set-active", "set-active-team", "update",
  "update-member-role", "update-role", "update-team",
];

describe("/api/auth/organization/* over HTTP", () => {
  it("answers 404 to every endpoint, POST and GET, with a valid session", async () => {
    const owner = await signUp("olivia");
    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme", userId: owner.id },
    });
    const before = JSON.stringify(db);

    const unmounted = await auth.handler(
      new Request(`${BASE}/api/auth/definitely-not-a-route`, { method: "POST" }),
    );
    assert.equal(unmounted.status, 404);

    for (const path of ORGANIZATION_PATHS) {
      for (const method of ["POST", "GET"] as const) {
        const url = new URL(`${BASE}/api/auth/organization/${path}`);
        if (method === "GET") url.searchParams.set("organizationId", org.id);
        const response = await auth.handler(
          new Request(url, {
            method,
            headers: {
              authorization: `Bearer ${owner.token}`,
              "content-type": "application/json",
              origin: BASE,
            },
            ...(method === "POST"
              ? {
                  body: JSON.stringify({
                    organizationId: org.id,
                    memberIdOrEmail: owner.id,
                    memberId: owner.id,
                    role: "admin,owner",
                    email: "x@example.com",
                    name: "Evil",
                    slug: "evil",
                    invitationId: "x",
                  }),
                }
              : {}),
          }),
        );
        // 404 for a mounted GET/POST endpoint; a method the endpoint does not
        // accept may be answered before hooks run, but never with a success.
        assert.ok(
          response.status === 404 || response.status === 405,
          `${method} /organization/${path} answered ${response.status}`,
        );
        if (method === "POST" || response.status !== 405) {
          assert.equal(response.status, 404, `${method} /organization/${path} answered ${response.status}`);
        }
      }
    }
    assert.equal(JSON.stringify(db), before, "a closed endpoint wrote something");
  });

  it("still lets server-side calls (no request) create a workspace", async () => {
    const user = await signUp("bob");
    const org = await auth.api.createOrganization({
      body: { name: "Bob's workspace", slug: "bob-ws", userId: user.id },
    });
    assert.ok(org?.id);
    assert.equal(db.member.length, 1);
    assert.equal(db.member[0]?.role, "owner");
  });

  it("refuses organization deletion even server-side", async () => {
    const user = await signUp("carol");
    const org = await auth.api.createOrganization({
      body: { name: "C", slug: "c", userId: user.id },
    });
    await assert.rejects(() =>
      auth.api.deleteOrganization({
        body: { organizationId: org.id },
        headers: new Headers({ authorization: `Bearer ${user.token}` }),
      }),
    );
    assert.equal(db.organization.length, 1);
  });

  it("the membership store writes invitation rows the plugin can read, under our own id", async () => {
    const user = await signUp("dora");
    const org = await auth.api.createOrganization({
      body: { name: "D", slug: "d", userId: user.id },
    });
    const context = (await auth.$context) as { adapter: MembershipAuthAdapter };
    const store = authMembershipStore(context.adapter);
    const id = "0123456789abcdef01234567";
    await store.insertOne("authInvitations", {
      id,
      organizationId: org.id,
      email: "x@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 1000 * 60),
      createdAt: new Date(),
      inviterId: user.id,
    });
    const [row] = await store.find("authInvitations", { id, organizationId: org.id });
    assert.equal(row?.id, id);
    assert.equal(row?.status, "pending");
  });

  it("the predicate itself: path prefix AND a request", () => {
    assert.equal(isOrganizationHttpRequest({ path: "/organization/create", request: {} }), true);
    assert.equal(isOrganizationHttpRequest({ path: "/organization/create" }), false);
    assert.equal(isOrganizationHttpRequest({ path: "/delete-user", request: {} }), false);
  });

  it("auth/auth.ts wires the shared hook and options (not a copy)", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "auth", "auth.ts"),
      "utf8",
    );
    assert.match(source, /before:\s*authBeforeHook/);
    assert.match(source, /organization\(organizationPluginOptions\)/);
    assert.equal(/sendInvitationEmail/.test(source.replace(/\/\/.*|\*.*$/gm, "")), false);
  });
});
