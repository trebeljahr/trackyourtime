/**
 * The account commands of the admin CLI: create-user, reset-password and
 * list-workspaces.
 *
 * Every write goes through better-auth rather than into its collections, for
 * the same reason the web app's sign-up does: the library owns password
 * hashing, the credential `account` row and its own validation, and
 * `auth/auth.ts` hangs the personal workspace off its `user.create` hook. A
 * user inserted straight into Mongo would have none of that, and would be a
 * shape no screen in the app was written for.
 *
 * Each function takes the auth instance as a parameter, so
 * `tests/admin-cli.test.ts` runs them against a real better-auth instance on
 * the in-memory adapter with the production hook wired in.
 */
import { randomBytes } from "node:crypto";
import {
  createPersonalWorkspace,
  upsertWorkspaceMember,
} from "../auth/personal-workspace.js";
import { CliError, authErrorMessage } from "./errors.js";

type Row = Record<string, unknown>;

type WhereClause = { field: string; value: unknown; operator?: string };

type AdminUser = { id: string; email: string; name?: string | null };

/**
 * The part of a better-auth instance these commands use. Structural, because
 * `getAuth()` is typed `any` (see `auth/auth.ts`); writing down exactly what
 * is called is the contract, and the integration test checks it against the
 * real library.
 */
export type AdminAuth = {
  api: {
    signUpEmail: (args: {
      body: { email: string; password: string; name: string };
    }) => Promise<{ user: AdminUser }>;
    resetPassword: (args: {
      body: { newPassword: string; token: string };
    }) => Promise<unknown>;
    createOrganization: (args: {
      body: { name: string; slug: string; userId: string };
    }) => Promise<{ id?: unknown } | null>;
  };
  $context: Promise<AdminAuthContext>;
};

export type AdminAuthContext = {
  adapter: {
    findMany: (args: {
      model: string;
      where?: WhereClause[];
      limit?: number;
      offset?: number;
      sortBy?: { field: string; direction: "asc" | "desc" };
    }) => Promise<Row[]>;
  };
  internalAdapter: {
    findUserByEmail: (email: string) => Promise<{ user: AdminUser } | null>;
    findUserById: (id: string) => Promise<AdminUser | null>;
    createVerificationValue: (data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }) => Promise<unknown>;
    deleteVerificationByIdentifier: (identifier: string) => Promise<unknown>;
    listSessions: (userId: string) => Promise<unknown[]>;
    deleteSessions: (userId: string) => Promise<unknown>;
  };
};

const PAGE = 500;

/**
 * Every row of a model. better-auth's adapter caps `findMany` at 100 rows
 * when no limit is passed, so an unpaged read would silently list the first
 * hundred workspaces of a larger instance and look complete.
 */
async function findAll(
  context: AdminAuthContext,
  model: string,
  where?: WhereClause[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await context.adapter.findMany({
      model,
      ...(where ? { where } : {}),
      limit: PAGE,
      offset,
      sortBy: { field: "createdAt", direction: "asc" },
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** better-auth stores a member's roles as a comma-separated string. */
export function hasRole(member: Row, role: string): boolean {
  const value = member.role;
  if (typeof value !== "string") return false;
  return value
    .split(",")
    .map((part) => part.trim())
    .includes(role);
}

export type CreatedUser = {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceRepaired: boolean;
};

/**
 * Create an account the way `/signup` does, then make sure it owns a personal
 * workspace with its app-side membership mirror.
 *
 * Sign-up runs the `user.create` hook, which creates the workspace — but that
 * hook is deliberately non-fatal (a signup must not fail on it), so success
 * of the sign-up proves nothing about the workspace. The CLI checks instead:
 * with no membership it creates the workspace itself, and with one it
 * re-asserts the mirror, which is an idempotent upsert and repairs the case
 * where the organization was written and the mirror was not.
 *
 * The session sign-up opens is revoked on the way out. It was handed to
 * nobody, and a session row for a device that does not exist would sit in
 * Settings → Devices for thirty days.
 */
export async function createUser(
  auth: AdminAuth,
  input: { email: string; name: string; password: string },
): Promise<CreatedUser> {
  const context = await auth.$context;

  if (await context.internalAdapter.findUserByEmail(input.email)) {
    throw new CliError(`an account with the email ${input.email} already exists`);
  }

  let user: AdminUser;
  try {
    const result = await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    user = result.user;
  } catch (error) {
    throw new CliError(`could not create the account: ${authErrorMessage(error)}`);
  }

  await context.internalAdapter.deleteSessions(user.id);

  const owner = { id: user.id, email: user.email, name: user.name ?? input.name };
  const memberships = await findAll(context, "member", [
    { field: "userId", value: user.id },
  ]);
  const owned = memberships.find((member) => hasRole(member, "owner"));

  if (owned && typeof owned.organizationId === "string") {
    await upsertWorkspaceMember({
      workspaceId: owned.organizationId,
      user: owner,
      role: "owner",
    });
    return {
      userId: user.id,
      email: user.email,
      workspaceId: owned.organizationId,
      workspaceRepaired: false,
    };
  }

  const workspaceId = await createPersonalWorkspace(auth.api, owner);
  if (!workspaceId) {
    throw new CliError(
      `created the account ${user.email}, but not its personal workspace. ` +
        "The server creates it on the account's first sign-in; see the server log for the cause.",
    );
  }
  return { userId: user.id, email: user.email, workspaceId, workspaceRepaired: true };
}

/** How long the one-shot reset token minted below is valid. It is used at once. */
const RESET_TOKEN_TTL_MS = 60_000;

export type PasswordReset = { userId: string; email: string; sessionsRevoked: number };

/**
 * Set a new password through better-auth's own `/reset-password` endpoint and
 * sign the account out everywhere.
 *
 * The endpoint takes a token rather than a user, and the only way to mint one
 * over the API is `requestPasswordReset`, which mails (or logs) a link. So the
 * CLI writes the verification row that endpoint would have written — same
 * identifier shape, a one-minute expiry — and redeems it immediately. What
 * runs is then exactly what a user clicking the emailed link runs: the length
 * rules, the hash, and a credential account created for an account that never
 * had a password (a Google-only sign-up).
 *
 * Sessions are deleted here rather than by the endpoint because
 * `revokeSessionsOnPasswordReset` is off in `auth/auth.ts`, which this package
 * does not change. Deleting the rows ends every bearer token at once; a
 * browser can keep answering from better-auth's five-minute cookie cache, and
 * the server's minute-by-minute socket re-check closes open sync sockets.
 */
export async function resetPassword(
  auth: AdminAuth,
  input: { email: string; password: string },
): Promise<PasswordReset> {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(input.email);
  if (!found) throw new CliError(`no account with the email ${input.email}`);
  const { user } = found;

  const token = randomBytes(24).toString("base64url");
  const identifier = `reset-password:${token}`;
  await context.internalAdapter.createVerificationValue({
    identifier,
    value: user.id,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });

  try {
    await auth.api.resetPassword({ body: { newPassword: input.password, token } });
  } catch (error) {
    // The endpoint deletes the row only on success. A refused password would
    // otherwise leave a live reset token behind for its remaining minute.
    await context.internalAdapter
      .deleteVerificationByIdentifier(identifier)
      .catch(() => undefined);
    throw new CliError(`could not set the password: ${authErrorMessage(error)}`);
  }

  const sessions = await context.internalAdapter.listSessions(user.id);
  await context.internalAdapter.deleteSessions(user.id);
  return { userId: user.id, email: user.email, sessionsRevoked: sessions.length };
}

export type WorkspaceSummary = {
  id: string;
  name: string;
  memberCount: number;
  ownerEmail: string | null;
};

/**
 * Every workspace with its member count and owner, read from better-auth's
 * `organization` and `member` records — the plugin's `member` row is the
 * source of truth for roles (see `models/WorkspaceMember.ts`).
 *
 * A workspace with more than one owner lists the longest-standing one. One
 * with none — possible only after a crash mid-way through an account
 * deletion — lists `null`, which is worth seeing rather than hiding.
 */
export async function listWorkspaces(auth: AdminAuth): Promise<WorkspaceSummary[]> {
  const context = await auth.$context;
  const organizations = await findAll(context, "organization");
  const members = await findAll(context, "member");

  const byWorkspace = new Map<string, Row[]>();
  for (const member of members) {
    const workspaceId = String(member.organizationId ?? "");
    const list = byWorkspace.get(workspaceId) ?? [];
    list.push(member);
    byWorkspace.set(workspaceId, list);
  }

  const emails = new Map<string, string | null>();
  const emailFor = async (userId: string): Promise<string | null> => {
    if (!emails.has(userId)) {
      const user = await context.internalAdapter.findUserById(userId);
      emails.set(userId, user?.email ?? null);
    }
    return emails.get(userId) ?? null;
  };

  const summaries: WorkspaceSummary[] = [];
  for (const organization of organizations) {
    const id = String(organization.id ?? "");
    const list = byWorkspace.get(id) ?? [];
    const owner = list.find((member) => hasRole(member, "owner"));
    summaries.push({
      id,
      name: String(organization.name ?? ""),
      memberCount: list.length,
      ownerEmail: owner ? await emailFor(String(owner.userId ?? "")) : null,
    });
  }
  return summaries;
}

/** A fixed-width table for a terminal. Columns size to their longest cell. */
export function formatWorkspaceTable(rows: readonly WorkspaceSummary[]): string {
  if (rows.length === 0) return "No workspaces.\n";
  const header = ["ID", "NAME", "MEMBERS", "OWNER"];
  const cells = rows.map((row) => [
    row.id,
    row.name,
    String(row.memberCount),
    row.ownerEmail ?? "(no owner)",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((line) => (line[column] ?? "").length)),
  );
  const render = (line: string[]): string =>
    line
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [render(header), ...cells.map(render)].join("\n") + "\n";
}
