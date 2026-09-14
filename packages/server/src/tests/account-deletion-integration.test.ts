/**
 * Account deletion, through the real better-auth `POST /delete-user`.
 *
 * `account-deletion.test.ts` pins the cascade. This pins the claims that live
 * in better-auth's behaviour and would be wrong if derived from its source:
 * that the endpoint works with a bearer token and no cookie (the mobile shells
 * have none), that `beforeDelete` can refuse a password account that sent no
 * password even though better-auth would accept its fresh session, that a
 * cascade failure leaves the account in place to retry, and that the
 * organization plugin's rows are reachable through the adapter under the
 * model names the store uses.
 *
 * Requests go through `auth.handler` with real `Request` objects rather than
 * `auth.api.*`, because the password rule is keyed on the request — which is
 * also what production sends.
 *
 * better-auth's in-memory adapter stands in for Mongo, as in
 * `session-lifetime-integration.test.ts`; app collections are the in-memory
 * row store.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { organization } from "better-auth/plugins/organization";
import { ACCOUNT_DELETION_PASSWORD_REQUIRED } from "@starter/shared";

import { accountDeletionOptions } from "../auth/account-deletion.js";
import { authBeforeHook } from "../services/membership/organization-lockdown.js";
import type { DeletionRowStore } from "../services/account-deletion/delete-account.js";
import { memoryRowStore, type MemoryRowStore } from "./support/memory-row-store.js";

type Row = Record<string, unknown> & { id: string };

type MemoryDb = Record<
  | "user"
  | "session"
  | "account"
  | "verification"
  | "organization"
  | "member"
  | "invitation"
  | "deviceCode",
  Row[]
>;

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: MemoryDb;
let appRows: MemoryRowStore;
/** Lets a test make the app half of the cascade fail. */
let failApp: boolean;
let deleted: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

const failingAware = (store: MemoryRowStore): DeletionRowStore => ({
  find: (...args) => store.find(...args),
  updateMany: (...args) => store.updateMany(...args),
  deleteMany: async (...args) => {
    if (failApp) throw new Error("database unavailable");
    return store.deleteMany(...args);
  },
});

beforeEach(() => {
  db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    deviceCode: [],
  };
  appRows = memoryRowStore();
  failApp = false;
  deleted = [];
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: "account-deletion-integration-secret-0123456789",
    baseURL: BASE,
    emailAndPassword: {
      enabled: true,
      // scrypt costs about a second per call, and hashing is not the subject.
      password: {
        hash: async (password: string) => `plain:${password}`,
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          hash === `plain:${password}`,
      },
    },
    user: {
      deleteUser: accountDeletionOptions({
        context: () => auth.$context,
        appRows: failingAware(appRows),
        onDeleted: (user) => deleted.push(user.id),
        log: () => undefined,
      }),
    },
    // The composite hook `auth/auth.ts` wires in, not the password step
    // alone: the organization lockdown runs first and must not swallow it.
    hooks: { before: authBeforeHook },
    // The same plugin set as production: the cascade writes to the tables of
    // both the organization and the device-authorization plugins.
    plugins: [
      bearer(),
      organization({ creatorRole: "owner" }),
      deviceAuthorization({ expiresIn: "10m", interval: "5s" }),
    ],
  });
});

async function signUp(
  name: string,
): Promise<{ id: string; email: string; token: string }> {
  const email = `${name}@example.com`;
  const response = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name },
    returnHeaders: true,
  });
  const token = response.headers.get("set-auth-token");
  assert.ok(token, "the bearer plugin should hand back a session token");
  return { id: response.response.user.id, email, token };
}

/** A personal workspace, the way `createPersonalWorkspace` makes one. */
async function workspaceFor(user: { id: string; email: string }): Promise<string> {
  const org = await auth.api.createOrganization({
    body: { name: `${user.email}'s workspace`, slug: `ws-${user.id}`, userId: user.id },
  });
  const workspaceId = String(org.id);
  appRows.rows.workspaceMembers ??= [];
  appRows.rows.workspaceMembers.push({
    workspaceId,
    userId: user.id,
    role: "owner",
    createdAt: new Date(),
    canViewOthersTime: true,
    canViewOthersMoney: true,
  });
  appRows.rows.timeEntries ??= [];
  appRows.rows.timeEntries.push({ id: `entry-${user.id}`, workspaceId, authorId: user.id });
  return workspaceId;
}

async function deleteAccount(
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response: Response = await auth.handler(
    new Request(`${BASE}/api/auth/delete-user`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function sessionFor(token: string): Promise<unknown> {
  return auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
    query: { disableCookieCache: true },
  });
}

describe("POST /delete-user with a bearer token", () => {
  it("refuses a password account that sent no password, though its session is fresh", async () => {
    const alice = await signUp("alice");
    await workspaceFor(alice);

    const result = await deleteAccount(alice.token);

    assert.equal(result.status, 400);
    assert.equal(result.json?.code, ACCOUNT_DELETION_PASSWORD_REQUIRED);
    assert.equal(db.user.length, 1);
    assert.equal(appRows.rows.timeEntries?.length, 1);
    assert.ok(await sessionFor(alice.token), "still signed in");
  });

  it("refuses a wrong password before touching any data", async () => {
    const alice = await signUp("alice");
    await workspaceFor(alice);

    const result = await deleteAccount(alice.token, { password: "wrong password!" });

    assert.equal(result.status, 400);
    assert.equal(result.json?.code, "INVALID_PASSWORD");
    assert.equal(db.user.length, 1);
    assert.equal(db.organization.length, 1);
    assert.equal(appRows.rows.timeEntries?.length, 1);
  });

  it("with the password, deletes the user, every session and everything they own", async () => {
    const alice = await signUp("alice");
    const second = await auth.api.signInEmail({
      body: { email: alice.email, password: PASSWORD },
      returnHeaders: true,
    });
    const otherDevice = second.headers.get("set-auth-token");
    assert.ok(otherDevice);
    await workspaceFor(alice);

    const result = await deleteAccount(alice.token, { password: PASSWORD });

    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.deepEqual(db.user, []);
    assert.deepEqual(db.account, []);
    assert.deepEqual(db.session, []);
    assert.deepEqual(db.organization, []);
    assert.deepEqual(db.member, []);
    assert.deepEqual(appRows.rows.timeEntries, []);
    assert.deepEqual(appRows.rows.workspaceMembers, []);
    assert.equal(await sessionFor(alice.token), null);
    assert.equal(await sessionFor(otherDevice), null, "the other device is signed out too");
    assert.deepEqual(deleted, [alice.id]);
  });

  it("leaves a shared workspace to the colleague, promoted in better-auth's member row", async () => {
    const alice = await signUp("alice");
    const bob = await signUp("bob");
    const team = await workspaceFor(alice);
    await workspaceFor(bob);
    await auth.api.addMember({
      body: { organizationId: team, userId: bob.id, role: "admin" },
    });
    appRows.rows.workspaceMembers?.push({
      workspaceId: team,
      userId: bob.id,
      role: "admin",
      createdAt: new Date(),
    });
    appRows.rows.timeEntries?.push({ id: "bob-in-team", workspaceId: team, authorId: bob.id });

    const result = await deleteAccount(alice.token, { password: PASSWORD });

    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.ok(db.organization.some((org) => org.id === team), "the team survives");
    const bobInTeam = db.member.find(
      (row) => row.organizationId === team && row.userId === bob.id,
    );
    assert.equal(bobInTeam?.role, "owner");
    assert.equal(db.member.some((row) => row.userId === alice.id), false);
    assert.deepEqual(
      appRows.rows.timeEntries?.map((row) => row.id).sort(),
      ["bob-in-team", `entry-${bob.id}`].sort(),
    );
    assert.ok(await sessionFor(bob.token), "Bob is still signed in");
  });

  it("keeps the account when the cascade fails, and deletes it on the retry", async () => {
    const alice = await signUp("alice");
    await workspaceFor(alice);

    failApp = true;
    const failed = await deleteAccount(alice.token, { password: PASSWORD });
    assert.ok(failed.status >= 500, `expected a server error, got ${failed.status}`);
    assert.equal(db.user.length, 1, "the user row survives a failed cascade");
    assert.ok(await sessionFor(alice.token), "and so does the session to retry with");

    failApp = false;
    const retried = await deleteAccount(alice.token, { password: PASSWORD });
    assert.equal(retried.status, 200, JSON.stringify(retried.json));
    assert.deepEqual(db.user, []);
    assert.deepEqual(appRows.rows.timeEntries, []);
  });

  describe("an account with no password (social sign-in only)", () => {
    const dropPassword = (userId: string): void => {
      for (const account of db.account) {
        if (account.userId === userId) account.password = null;
      }
    };

    it("deletes on a fresh session with nothing to type", async () => {
      const alice = await signUp("alice");
      await workspaceFor(alice);
      dropPassword(alice.id);

      const result = await deleteAccount(alice.token);

      assert.equal(result.status, 200, JSON.stringify(result.json));
      assert.deepEqual(db.user, []);
    });

    it("must sign in again once the session is more than a day old", async () => {
      const alice = await signUp("alice");
      await workspaceFor(alice);
      dropPassword(alice.id);
      for (const session of db.session) {
        session.createdAt = new Date(Date.now() - 2 * 86_400_000);
      }

      const result = await deleteAccount(alice.token);

      assert.equal(result.status, 400);
      assert.equal(result.json?.code, "SESSION_EXPIRED");
      assert.equal(db.user.length, 1);
      assert.equal(appRows.rows.timeEntries?.length, 1);
    });
  });
});
