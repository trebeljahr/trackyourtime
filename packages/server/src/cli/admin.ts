#!/usr/bin/env node
/**
 * Instance admin CLI for a self-hosted Track Your Time.
 *
 *   docker compose -f docker-compose.selfhost.yml exec server node dist/cli/admin.js <command>
 *   pnpm --filter @starter/server admin <command>          (from a checkout)
 *
 * `node dist/cli/admin.js help` lists the commands. The image ships only
 * `dist`, `package.json` and `node_modules`, so this file is compiled by the
 * normal server build and needs nothing else at runtime.
 *
 * It is deliberately a process of its own rather than an HTTP endpoint: the
 * operator proves who they are by being able to run a command inside the
 * server container, which is a stronger check than any password the instance
 * could ask for, and there is no admin surface on the network to attack.
 */
import { runAdmin } from "./main.js";
import { doctorInputsFromEnv, withAuth } from "./runtime.js";

const code = await runAdmin(
  process.argv.slice(2),
  { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  { withAuth, doctorInputs: doctorInputsFromEnv },
).catch((error: unknown) => {
  process.stderr.write(
    `admin: unexpected error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  return 1;
});

// Exit explicitly: modules the auth instance imports can leave timers behind,
// and a CLI that hangs after printing "Created" looks like one that did not.
// Flush first — on a pipe, stdout is asynchronous and exit would cut it off.
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
process.exit(code);
