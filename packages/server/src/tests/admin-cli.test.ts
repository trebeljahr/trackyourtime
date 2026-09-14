/**
 * The instance admin CLI (`cli/`).
 *
 * Three layers, each against the most real thing that runs without a server:
 *
 *   - argument parsing and the password prompt's key handling, pure;
 *   - create-user, reset-password and list-workspaces against a real
 *     better-auth instance on its in-memory adapter, with the organization
 *     plugin and the production `user.create` hook (`createPersonalWorkspace`)
 *     wired in. Only the app-side member mirror is stubbed, because it is a
 *     mongoose model and there is no database here; the stub records every
 *     write, which is what the mirror assertions read;
 *   - doctor, with every check driven by an injected environment, and a whole
 *     `runAdmin` run to pin the exit codes an operator's script depends on.
 */
import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import { organization } from "better-auth/plugins/organization";

import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { createPersonalWorkspace } from "../auth/personal-workspace.js";
import { parseAdminArgs } from "../cli/args.js";
import {
  createUser,
  formatWorkspaceTable,
  listWorkspaces,
  resetPassword,
  type AdminAuth,
} from "../cli/accounts.js";
import {
  CLOCK_SKEW_FAIL_MS,
  CLOCK_SKEW_WARN_MS,
  checkAuthUrl,
  checkClockSkew,
  checkMail,
  checkMongo,
  checkRedis,
  checkTrustedOrigins,
  doctorExitCode,
  formatDoctorReport,
  probeMongo,
  type DoctorInputs,
  type UrlState,
} from "../cli/doctor.js";
import { CliError } from "../cli/errors.js";
import { runAdmin, type AdminIo, type AdminRuntime } from "../cli/main.js";
import { applyKeys, promptNewPassword } from "../cli/prompt.js";

// ── argument parsing ──────────────────────────────────────────────────────

describe("parseAdminArgs", () => {
  it("reads create-user with and without a password", () => {
    assert.deepEqual(parseAdminArgs(["create-user", "--email", "a@example.com", "--name", "Ada"]), {
      ok: true,
      command: { kind: "create-user", email: "a@example.com", name: "Ada" },
    });
    assert.deepEqual(
      parseAdminArgs(["create-user", "--email=a@example.com", "--name=Ada", "--password", " spaced "]),
      {
        ok: true,
        command: { kind: "create-user", email: "a@example.com", name: "Ada", password: " spaced " },
      },
    );
  });

  it("requires --email and --name for create-user", () => {
    const noName = parseAdminArgs(["create-user", "--email", "a@example.com"]);
    assert.equal(noName.ok, false);
    assert.match(!noName.ok ? noName.error : "", /--name/);
    const blankEmail = parseAdminArgs(["create-user", "--email", "  ", "--name", "Ada"]);
    assert.match(!blankEmail.ok ? blankEmail.error : "", /--email/);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    const result = parseAdminArgs(["reset-password", "--emial", "a@example.com"]);
    assert.equal(result.ok, false);
  });

  it("refuses an empty --password instead of setting an empty password", () => {
    const result = parseAdminArgs(["reset-password", "--email", "a@example.com", "--password", ""]);
    assert.equal(result.ok, false);
  });

  it("refuses positional arguments and unknown commands", () => {
    assert.equal(parseAdminArgs(["doctor", "now"]).ok, false);
    assert.equal(parseAdminArgs(["drop-database"]).ok, false);
  });

  it("reads --json on list-workspaces and doctor, and help in every spelling", () => {
    assert.deepEqual(parseAdminArgs(["doctor", "--json"]), {
      ok: true,
      command: { kind: "doctor", json: true },
    });
    assert.deepEqual(parseAdminArgs(["list-workspaces"]), {
      ok: true,
      command: { kind: "list-workspaces", json: false },
    });
    for (const argv of [[], ["help"], ["--help"], ["-h"], ["create-user", "--help"]]) {
      assert.deepEqual(parseAdminArgs(argv), { ok: true, command: { kind: "help" } });
    }
  });
});

describe("password prompt", () => {
  it("applies Enter, Backspace, control characters and Ctrl+C", () => {
    assert.deepEqual(applyKeys("", "secret\r"), { buffer: "secret", done: true, aborted: false });
    assert.deepEqual(applyKeys("secrex", "t"), { buffer: "secret", done: false, aborted: false });
    assert.deepEqual(applyKeys("se", "cr"), { buffer: "secr", done: false, aborted: false });
    assert.equal(applyKeys("secret", "").aborted, true);
  });

  it("reads the first line of a piped stdin and never writes it back", async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const answer = promptNewPassword({ input, output: { write: (chunk) => written.push(chunk) } });
    input.end("piped password\nsecond line\n");
    assert.equal(await answer, "piped password");
    assert.equal(written.join("").includes("piped password"), false);
  });

  it("refuses an empty piped stdin", async () => {
    const input = new PassThrough();
    const answer = promptNewPassword({ input, output: { write: () => true } });
    input.end("");
    await assert.rejects(answer, CliError);
  });
});

// ── accounts, through the real auth API ───────────────────────────────────

type Row = Record<string, unknown> & { id: string };
type MemoryDb = Record<
  "user" | "session" | "account" | "verification" | "organization" | "member" | "invitation",
  Row[]
>;

const PASSWORD = "correct horse battery";
const BASE = "http://localhost:3000";

let db: MemoryDb;
let mirror: Array<{ filter: Record<string, unknown>; update: { $set: Record<string, unknown> } }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
/** Lets a test make the production hook's workspace creation fail. */
let hookCreatesWorkspace: boolean;

mock.method(WorkspaceMember, "updateOne", async (filter: never, update: never) => {
  mirror.push({ filter, update });
  return { acknowledged: true };
});
after(() => mock.restoreAll());

beforeEach(() => {
  db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  mirror = [];
  hookCreatesWorkspace = true;
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: "admin-cli-integration-secret-0123456789abcdef",
    baseURL: BASE,
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      // scrypt costs about a second per call, and hashing is not the subject.
      password: {
        hash: async (password: string) => `plain:${password}`,
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          hash === `plain:${password}`,
      },
    },
    plugins: [bearer(), organization({ creatorRole: "owner" })],
    // The hook `auth/auth.ts` registers, calling the same function.
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name?: string; email?: string }) => {
            if (hookCreatesWorkspace) await createPersonalWorkspace(auth.api, user);
          },
        },
      },
    },
  });
});

async function signIn(email: string, password: string): Promise<string | null> {
  try {
    const response = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    return response.headers.get("set-auth-token");
  } catch {
    return null;
  }
}

async function sessionFor(token: string): Promise<unknown> {
  return auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
}

describe("create-user", () => {
  it("creates an account that can sign in and owns one personal workspace, mirrored", async () => {
    const created = await createUser(auth as AdminAuth, {
      email: "ada@example.com",
      name: "Ada",
      password: PASSWORD,
    });

    assert.equal(created.email, "ada@example.com");
    assert.equal(db.organization.length, 1, "exactly one workspace, not a second from the CLI");
    assert.equal(created.workspaceId, db.organization[0]?.id);

    const members = db.member.filter((member) => member.userId === created.userId);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.role, "owner");
    assert.equal(members[0]?.organizationId, created.workspaceId);

    const mirrored = mirror.filter((write) => write.filter.userId === created.userId);
    assert.ok(mirrored.length >= 1, "the app-side member mirror is written");
    for (const write of mirrored) {
      assert.equal(write.filter.workspaceId, created.workspaceId);
      assert.equal(write.update.$set.role, "owner");
    }

    assert.equal(db.session.length, 0, "the sign-up session is handed to nobody and revoked");
    assert.ok(await signIn("ada@example.com", PASSWORD), "the new account signs in");
  });

  it("creates the workspace itself when the sign-up hook did not", async () => {
    hookCreatesWorkspace = false;
    const created = await createUser(auth as AdminAuth, {
      email: "ben@example.com",
      name: "Ben",
      password: PASSWORD,
    });
    assert.equal(db.organization.length, 1);
    assert.equal(created.workspaceId, db.organization[0]?.id);
    assert.ok(mirror.some((write) => write.filter.workspaceId === created.workspaceId));
  });

  it("refuses an email that already has an account, and a password better-auth refuses", async () => {
    await createUser(auth as AdminAuth, { email: "ada@example.com", name: "Ada", password: PASSWORD });
    await assert.rejects(
      createUser(auth as AdminAuth, { email: "ada@example.com", name: "Ada 2", password: PASSWORD }),
      (error: unknown) => error instanceof CliError && /already exists/.test(error.message),
    );
    await assert.rejects(
      createUser(auth as AdminAuth, { email: "cy@example.com", name: "Cy", password: "short" }),
      (error: unknown) => error instanceof CliError && /could not create/.test(error.message),
    );
    assert.equal(db.user.length, 1);
  });
});

describe("reset-password", () => {
  it("sets the new password and signs every device out", async () => {
    await createUser(auth as AdminAuth, { email: "ada@example.com", name: "Ada", password: PASSWORD });
    const phone = await signIn("ada@example.com", PASSWORD);
    const laptop = await signIn("ada@example.com", PASSWORD);
    assert.ok(phone && laptop);
    assert.ok(await sessionFor(phone), "signed in before the reset");

    const reset = await resetPassword(auth as AdminAuth, {
      email: "ada@example.com",
      password: "a brand new passphrase",
    });

    assert.equal(reset.sessionsRevoked, 2);
    assert.equal(await sessionFor(phone), null, "the phone is signed out");
    assert.equal(await sessionFor(laptop), null, "the laptop is signed out");
    assert.equal(await signIn("ada@example.com", PASSWORD), null, "the old password is gone");
    assert.ok(await signIn("ada@example.com", "a brand new passphrase"));
    assert.equal(db.verification.length, 0, "the one-shot token is consumed");
  });

  it("leaves no reset token and no revoked sessions behind when the password is refused", async () => {
    await createUser(auth as AdminAuth, { email: "ada@example.com", name: "Ada", password: PASSWORD });
    const phone = await signIn("ada@example.com", PASSWORD);
    assert.ok(phone);
    await assert.rejects(
      resetPassword(auth as AdminAuth, { email: "ada@example.com", password: "short" }),
      CliError,
    );
    assert.equal(db.verification.length, 0);
    assert.ok(await sessionFor(phone), "a refused reset signs nobody out");
  });

  it("refuses an unknown email", async () => {
    await assert.rejects(
      resetPassword(auth as AdminAuth, { email: "nobody@example.com", password: PASSWORD }),
      (error: unknown) => error instanceof CliError && /no account/.test(error.message),
    );
  });
});

describe("list-workspaces", () => {
  it("lists id, name, member count and owner email", async () => {
    const ada = await createUser(auth as AdminAuth, { email: "ada@example.com", name: "Ada", password: PASSWORD });
    const ben = await createUser(auth as AdminAuth, { email: "ben@example.com", name: "Ben", password: PASSWORD });
    const context = await auth.$context;
    await context.adapter.create({
      model: "member",
      data: { organizationId: ada.workspaceId, userId: ben.userId, role: "member", createdAt: new Date() },
    });

    const rows = await listWorkspaces(auth as AdminAuth);
    assert.equal(rows.length, 2);
    const adas = rows.find((row) => row.id === ada.workspaceId);
    assert.equal(adas?.memberCount, 2);
    assert.equal(adas?.ownerEmail, "ada@example.com");
    assert.equal(rows.find((row) => row.id === ben.workspaceId)?.memberCount, 1);

    const table = formatWorkspaceTable(rows);
    assert.match(table, /^ID\s+NAME\s+MEMBERS\s+OWNER/);
    assert.match(table, /ada@example\.com/);
    assert.equal(formatWorkspaceTable([]), "No workspaces.\n");
  });
});

// ── doctor ────────────────────────────────────────────────────────────────

const selfHost = (overrides: Partial<UrlState> = {}): UrlState => ({
  appUrl: "https://time.example.com",
  frontendUrl: "https://time.example.com",
  betterAuthUrl: "https://time.example.com",
  trustedOrigins: ["https://time.example.com"],
  isProduction: true,
  ...overrides,
});

describe("doctor: trusted origins", () => {
  it("passes when the app origin is trusted verbatim", () => {
    assert.equal(checkTrustedOrigins(selfHost()).status, "pass");
    assert.equal(
      checkTrustedOrigins(selfHost({ trustedOrigins: ["https://time.example.com", "capacitor://localhost"] }))
        .status,
      "pass",
    );
  });

  it("fails when TRUSTED_ORIGINS omits the app origin", () => {
    const result = checkTrustedOrigins(
      selfHost({ appUrl: "https://time.example.com", trustedOrigins: ["https://old.example.com"] }),
    );
    assert.equal(result.status, "fail");
    assert.match(result.fix ?? "", /https:\/\/time\.example\.com/);
  });

  it("fails when the app origin is only listed in a spelling no browser sends", () => {
    const result = checkTrustedOrigins(selfHost({ trustedOrigins: ["https://time.example.com/"] }));
    assert.equal(result.status, "fail");
    assert.match(result.detail, /listed only as/);
  });

  it("fails with no app URL at all, or one that does not parse", () => {
    assert.equal(checkTrustedOrigins(selfHost({ appUrl: "", frontendUrl: "" })).status, "fail");
    assert.equal(checkTrustedOrigins(selfHost({ appUrl: "time.example.com" })).status, "fail");
  });

  it("warns about an extra entry that can never match", () => {
    const result = checkTrustedOrigins(
      selfHost({ trustedOrigins: ["https://time.example.com", "https://ext.example.com/path"] }),
    );
    assert.equal(result.status, "warn");
  });
});

describe("doctor: auth URL", () => {
  it("passes on the app origin", () => {
    assert.equal(checkAuthUrl(selfHost()).status, "pass");
    assert.equal(
      checkAuthUrl(selfHost({ appUrl: "http://localhost", frontendUrl: "http://localhost", betterAuthUrl: "http://localhost", trustedOrigins: ["http://localhost"] }))
        .status,
      "pass",
    );
  });

  it("fails when missing or malformed", () => {
    assert.equal(checkAuthUrl(selfHost({ betterAuthUrl: "" })).status, "fail");
    assert.equal(checkAuthUrl(selfHost({ betterAuthUrl: "not a url" })).status, "fail");
    assert.equal(checkAuthUrl(selfHost({ betterAuthUrl: "ftp://time.example.com" })).status, "fail");
  });

  it("fails on a different origin when APP_URL makes the stack single-origin", () => {
    assert.equal(checkAuthUrl(selfHost({ betterAuthUrl: "https://api.example.com" })).status, "fail");
  });

  it("only warns on a different origin for an API on its own host", () => {
    const split = selfHost({
      appUrl: "",
      frontendUrl: "https://time.example.com",
      betterAuthUrl: "https://api.time.example.com",
    });
    assert.equal(checkAuthUrl(split).status, "warn");
  });

  it("warns on a path, and on plain http for a public host in production", () => {
    assert.equal(checkAuthUrl(selfHost({ betterAuthUrl: "https://time.example.com/api/auth" })).status, "warn");
    const http = "http://time.example.com";
    assert.equal(
      checkAuthUrl(selfHost({ appUrl: http, frontendUrl: http, betterAuthUrl: http, trustedOrigins: [http] })).status,
      "warn",
    );
  });
});

describe("doctor: services", () => {
  it("database: pass on an answer, fail on an error", async () => {
    const answered = await probeMongo(async () => ({ serverTime: new Date() }));
    assert.equal(checkMongo(answered).status, "pass");
    const refused = await probeMongo(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:27017");
    });
    const result = checkMongo(refused);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /ECONNREFUSED/);
  });

  it("clock: pass, warn and fail by the size of the skew, in either direction", () => {
    const at = (skewMs: number) =>
      checkClockSkew({ ok: true, serverTime: new Date(1_000_000 - skewMs), startedAt: 1_000_000, finishedAt: 1_000_000 });
    assert.equal(at(250).status, "pass");
    assert.equal(at(CLOCK_SKEW_WARN_MS).status, "warn");
    assert.equal(at(-CLOCK_SKEW_WARN_MS).status, "warn");
    assert.equal(at(CLOCK_SKEW_FAIL_MS).status, "fail");
    assert.match(at(-CLOCK_SKEW_FAIL_MS).detail, /behind/);
    assert.equal(checkClockSkew({ ok: false, error: "down" }).status, "warn");
  });

  it("clock: the round trip is not counted as skew", () => {
    // A 4 s round trip to a database whose clock reads the midpoint.
    const result = checkClockSkew({ ok: true, serverTime: new Date(2_000), startedAt: 0, finishedAt: 4_000 });
    assert.equal(result.status, "pass");
    assert.match(result.detail, /in step/);
  });

  it("redis: warn when unset, pass on PONG, fail when configured and unreachable", async () => {
    assert.equal((await checkRedis("", async () => undefined)).status, "warn");
    assert.equal((await checkRedis("redis://redis:6379", async () => undefined)).status, "pass");
    const down = await checkRedis("redis://redis:6379", async () => {
      throw new Error("getaddrinfo ENOTFOUND redis");
    });
    assert.equal(down.status, "fail");
  });

  it("mail: warn with no transport, fail on SMTP with no sender, pass otherwise", () => {
    assert.equal(checkMail({ configured: false, transport: "console", fromAddress: "" }).status, "warn");
    assert.equal(checkMail({ configured: true, transport: "smtp", fromAddress: "" }).status, "fail");
    assert.equal(checkMail({ configured: true, transport: "smtp", fromAddress: "t@example.com" }).status, "pass");
    assert.equal(checkMail({ configured: true, transport: "listmonk", fromAddress: "" }).status, "pass");
  });

  it("exits non-zero on any fail, and zero on warnings alone", () => {
    assert.equal(doctorExitCode([{ name: "a", status: "warn", detail: "" }]), 0);
    assert.equal(
      doctorExitCode([
        { name: "a", status: "pass", detail: "" },
        { name: "b", status: "fail", detail: "" },
      ]),
      1,
    );
    assert.match(formatDoctorReport([{ name: "a", status: "pass", detail: "ok" }]), /All checks passed/);
  });
});

// ── the whole command ─────────────────────────────────────────────────────

function capture(): { io: AdminIo; stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      stdin: new PassThrough(),
      stdout: { write: (chunk: string) => (out += chunk) },
      stderr: { write: (chunk: string) => (err += chunk) },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

const healthyInputs = (urls: UrlState): DoctorInputs => ({
  urls,
  mail: { configured: false, transport: "console", fromAddress: "" },
  redisUrl: "redis://redis:6379",
  mongo: async () => ({ serverTime: new Date() }),
  redisPing: async () => undefined,
});

const runtimeFor = (inputs: DoctorInputs): AdminRuntime => ({
  withAuth: async (task) => task(auth as AdminAuth),
  doctorInputs: async () => inputs,
});

describe("runAdmin", () => {
  it("doctor exits 1 and says why when TRUSTED_ORIGINS omits the app origin", async () => {
    const run = capture();
    const code = await runAdmin(
      ["doctor"],
      run.io,
      runtimeFor(healthyInputs(selfHost({ trustedOrigins: ["https://elsewhere.example.com"] }))),
    );
    assert.equal(code, 1);
    assert.match(run.stdout(), /FAIL\s+trusted-origins/);
  });

  it("doctor exits 0 on a healthy instance with warnings, and --json is parseable", async () => {
    const run = capture();
    const code = await runAdmin(["doctor", "--json"], run.io, runtimeFor(healthyInputs(selfHost())));
    assert.equal(code, 0);
    const results = JSON.parse(run.stdout()) as Array<{ name: string; status: string }>;
    assert.deepEqual(
      results.map((result) => result.name),
      ["database", "redis", "mail", "trusted-origins", "auth-url", "clock"],
    );
  });

  it("exits 2 on a usage error and 0 on help", async () => {
    const bad = capture();
    assert.equal(await runAdmin(["create-user"], bad.io, runtimeFor(healthyInputs(selfHost()))), 2);
    assert.match(bad.stderr(), /needs --email/);
    const help = capture();
    assert.equal(await runAdmin(["help"], help.io, runtimeFor(healthyInputs(selfHost()))), 0);
    assert.match(help.stdout(), /create-user/);
  });

  it("create-user takes the password from stdin, and reports a refusal as exit 1", async () => {
    const run = capture();
    (run.io.stdin as PassThrough).end(`${PASSWORD}\n`);
    const code = await runAdmin(
      ["create-user", "--email", "ada@example.com", "--name", "Ada"],
      run.io,
      runtimeFor(healthyInputs(selfHost())),
    );
    assert.equal(code, 0, run.stderr());
    assert.match(run.stdout(), /Created ada@example\.com/);
    assert.equal(run.stdout().includes(PASSWORD), false, "the password is never printed");
    assert.ok(await signIn("ada@example.com", PASSWORD));

    const again = capture();
    const refused = await runAdmin(
      ["create-user", "--email", "ada@example.com", "--name", "Ada", "--password", PASSWORD],
      again.io,
      runtimeFor(healthyInputs(selfHost())),
    );
    assert.equal(refused, 1);
    assert.match(again.stderr(), /already exists/);
  });
});
