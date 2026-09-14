/**
 * The admin CLI's command dispatch, separate from `cli/admin.ts` so a test can
 * run a whole command with its own streams and read the exit code, instead of
 * spawning a process.
 */
import { USAGE, parseAdminArgs, type AdminCommand } from "./args.js";
import {
  createUser,
  formatWorkspaceTable,
  listWorkspaces,
  resetPassword,
} from "./accounts.js";
import { doctorExitCode, formatDoctorReport, runDoctor, type DoctorInputs } from "./doctor.js";
import { CliError } from "./errors.js";
import { promptNewPassword, type SecretInput, type SecretOutput } from "./prompt.js";
import type { AdminAuth } from "./accounts.js";

export type AdminIo = {
  stdin: SecretInput;
  stdout: SecretOutput;
  stderr: SecretOutput;
};

/** What a command needs from outside; `cli/runtime.ts` in production. */
export type AdminRuntime = {
  withAuth: <T>(task: (auth: AdminAuth) => Promise<T>) => Promise<T>;
  doctorInputs: () => Promise<DoctorInputs>;
};

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export async function runAdmin(
  argv: readonly string[],
  io: AdminIo,
  runtime: AdminRuntime,
): Promise<number> {
  const parsed = parseAdminArgs(argv);
  if (!parsed.ok) {
    io.stderr.write(`admin: ${parsed.error}\nRun "node dist/cli/admin.js help" for the commands and their options.\n`);
    return EXIT_USAGE;
  }

  try {
    return await execute(parsed.command, io, runtime);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr.write(`admin: ${error.message}\n`);
      return EXIT_FAILED;
    }
    throw error;
  }
}

async function execute(command: AdminCommand, io: AdminIo, runtime: AdminRuntime): Promise<number> {
  switch (command.kind) {
    case "help":
      io.stdout.write(USAGE);
      return EXIT_OK;

    case "create-user": {
      // Asked for before connecting: a prompt that waits on a person should
      // not hold a database connection open while it does.
      const password =
        command.password ?? (await promptNewPassword({ input: io.stdin, output: io.stderr }));
      const created = await runtime.withAuth((auth) =>
        createUser(auth, { email: command.email, name: command.name, password }),
      );
      io.stdout.write(
        `Created ${created.email} (user ${created.userId}) with personal workspace ${created.workspaceId}.\n`,
      );
      return EXIT_OK;
    }

    case "reset-password": {
      const password =
        command.password ??
        (await promptNewPassword({ input: io.stdin, output: io.stderr }, "New password"));
      const reset = await runtime.withAuth((auth) =>
        resetPassword(auth, { email: command.email, password }),
      );
      const plural = reset.sessionsRevoked === 1 ? "session" : "sessions";
      io.stdout.write(
        `Set a new password for ${reset.email} and signed out ${reset.sessionsRevoked} ${plural}.\n`,
      );
      return EXIT_OK;
    }

    case "list-workspaces": {
      const rows = await runtime.withAuth((auth) => listWorkspaces(auth));
      io.stdout.write(command.json ? `${JSON.stringify(rows, null, 2)}\n` : formatWorkspaceTable(rows));
      return EXIT_OK;
    }

    case "doctor": {
      const results = await runDoctor(await runtime.doctorInputs());
      io.stdout.write(
        command.json ? `${JSON.stringify(results, null, 2)}\n` : formatDoctorReport(results),
      );
      return doctorExitCode(results);
    }
  }
}
