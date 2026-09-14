/**
 * Argument parsing for the instance admin CLI (`cli/admin.ts`).
 *
 * Pure: argv in, a command or a usage error out. Nothing here touches the
 * environment, a database or the terminal, which is what lets
 * `tests/admin-cli.test.ts` pin every accepted and refused shape.
 *
 * Built on `node:util` `parseArgs` in strict mode, so an unknown or misspelled
 * flag is an error rather than silently ignored. An operator who types
 * `--emial` into a password reset must be told, not handed a prompt for an
 * account the command never looked up.
 */
import { parseArgs } from "node:util";

export type AdminCommand =
  | { kind: "help" }
  | { kind: "create-user"; email: string; name: string; password?: string }
  | { kind: "reset-password"; email: string; password?: string }
  | { kind: "list-workspaces"; json: boolean }
  | { kind: "doctor"; json: boolean };

export type ParseResult =
  | { ok: true; command: AdminCommand }
  | { ok: false; error: string };

export const USAGE = `Track Your Time instance admin

Usage:
  node dist/cli/admin.js <command> [options]

  In the self-host stack:
    docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js <command>

Commands:
  create-user     --email <address> --name <name> [--password <password>]
                  Create an account with its personal workspace. Without
                  --password the password is prompted for and never echoed.

  reset-password  --email <address> [--password <password>]
                  Set a new password and sign the account out on every device.

  list-workspaces [--json]
                  Every workspace: id, name, member count, owner email.

  doctor          [--json]
                  Check the database, Redis, mail, trusted origins, the auth
                  URL and clock skew. Exits 1 when any check fails.

  help            Show this text.

Exit codes: 0 success, 1 the command or a doctor check failed, 2 usage error.
`;

type OptionSpec = Record<string, { type: "string" | "boolean" }>;

function parseFlags(
  args: string[],
  options: OptionSpec,
): { ok: true; values: Record<string, string | boolean | undefined> } | { ok: false; error: string } {
  try {
    const { values } = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: false,
    });
    return { ok: true, values: values as Record<string, string | boolean | undefined> };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A string flag that must be present and non-blank. */
function required(
  values: Record<string, string | boolean | undefined>,
  flag: string,
  command: string,
): string | { error: string } {
  const value = values[flag];
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `${command} needs --${flag}` };
  }
  return value.trim();
}

/**
 * A password flag, which is taken verbatim — never trimmed. A password that
 * begins or ends with a space is a legal password, and trimming it here would
 * set a different one from the one the operator typed.
 */
function optionalPassword(
  values: Record<string, string | boolean | undefined>,
): string | undefined | { error: string } {
  const value = values.password;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    return { error: "--password was given an empty value; omit it to be prompted" };
  }
  return value;
}

function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export function parseAdminArgs(argv: readonly string[]): ParseResult {
  const [name, ...rest] = argv;

  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { ok: true, command: { kind: "help" } };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return { ok: true, command: { kind: "help" } };
  }

  switch (name) {
    case "create-user": {
      const parsed = parseFlags(rest, {
        email: { type: "string" },
        name: { type: "string" },
        password: { type: "string" },
      });
      if (!parsed.ok) return parsed;
      const email = required(parsed.values, "email", name);
      if (isError(email)) return { ok: false, error: email.error };
      const displayName = required(parsed.values, "name", name);
      if (isError(displayName)) return { ok: false, error: displayName.error };
      const password = optionalPassword(parsed.values);
      if (isError(password)) return { ok: false, error: password.error };
      return {
        ok: true,
        command: {
          kind: "create-user",
          email,
          name: displayName,
          ...(password === undefined ? {} : { password }),
        },
      };
    }

    case "reset-password": {
      const parsed = parseFlags(rest, {
        email: { type: "string" },
        password: { type: "string" },
      });
      if (!parsed.ok) return parsed;
      const email = required(parsed.values, "email", name);
      if (isError(email)) return { ok: false, error: email.error };
      const password = optionalPassword(parsed.values);
      if (isError(password)) return { ok: false, error: password.error };
      return {
        ok: true,
        command: {
          kind: "reset-password",
          email,
          ...(password === undefined ? {} : { password }),
        },
      };
    }

    case "list-workspaces":
    case "doctor": {
      const parsed = parseFlags(rest, { json: { type: "boolean" } });
      if (!parsed.ok) return parsed;
      return { ok: true, command: { kind: name, json: parsed.values.json === true } };
    }

    default:
      return { ok: false, error: `unknown command "${name}"` };
  }
}
