/**
 * `admin migrate`: the schema state, what would run, or the run itself.
 * The server applies migrations at every start; this is for looking before an
 * upgrade and for applying without starting the server.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { MigrateMode } from "./args.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaTooNewError,
  migrationStatus,
  runMigrations,
  type Migration,
  type MigrationStatus,
} from "../services/migrations/index.js";

export type MigrateOutput = { stdout: string; exitCode: number };

export async function runMigrate(
  db: Db,
  release: string,
  mode: MigrateMode,
  json: boolean,
  migrations: readonly Migration[] = MIGRATIONS,
  schemaVersion: number = SCHEMA_VERSION,
): Promise<MigrateOutput> {
  const before = await migrationStatus(db, migrations, schemaVersion);
  if (mode !== "apply" || !before.readable) {
    const exitCode = before.readable ? 0 : 1;
    return {
      stdout: json ? `${JSON.stringify(statusJson(before), null, 2)}\n` : formatStatus(before, mode),
      exitCode,
    };
  }

  const lines: string[] = [];
  try {
    const applied = await runMigrations({
      db,
      migrations,
      schemaVersion,
      owner: `admin:${hostname()}:${process.pid}:${randomUUID()}`,
      release,
      logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    const after = await migrationStatus(db, migrations, schemaVersion);
    if (json) {
      return { stdout: `${JSON.stringify({ ...statusJson(after), appliedNow: applied }, null, 2)}\n`, exitCode: 0 };
    }
    lines.push(applied.length === 0 ? "Nothing to apply." : `Applied ${applied.join(", ")}.`);
    return { stdout: `${lines.join("\n")}\n`, exitCode: 0 };
  } catch (error) {
    if (error instanceof SchemaTooNewError) {
      return { stdout: `${lines.join("\n")}${lines.length ? "\n" : ""}${error.message}\n`, exitCode: 1 };
    }
    throw error;
  }
}

function statusJson(status: MigrationStatus) {
  return {
    schemaVersion: status.schemaVersion,
    requiredReaderSchema: status.requiredReaderSchema,
    readable: status.readable,
    applied: status.applied.map((record) => ({
      id: record._id,
      description: record.description,
      minReaderSchema: record.minReaderSchema,
      appliedAt: record.appliedAt.toISOString(),
      release: record.release,
    })),
    pending: status.pending.map(({ id, description, minReaderSchema }) => ({
      id,
      description,
      minReaderSchema,
    })),
  };
}

export function formatStatus(status: MigrationStatus, mode: "status" | "dry-run" | "apply"): string {
  const lines: string[] = [
    `This build reads schema up to ${status.schemaVersion}; the database requires ${status.requiredReaderSchema}.`,
  ];
  if (!status.readable) {
    const release = status.raisedBy?.release ? `v${status.raisedBy.release}` : "a newer release";
    lines.push(
      `REFUSED: the database was migrated by ${release}. Upgrade, or restore the mongodump taken before upgrading.`,
    );
  }
  if (mode === "status") {
    lines.push("", "Applied:");
    if (status.applied.length === 0) lines.push("  (none)");
    for (const record of status.applied) {
      const unknown = status.unknownApplied.includes(record) ? " [from a newer release]" : "";
      lines.push(
        `  ${String(record._id).padStart(3)}  ${record.description} (${record.appliedAt.toISOString()}, v${record.release || "?"})${unknown}`,
      );
    }
  }
  lines.push("", mode === "dry-run" ? "Would apply:" : "Pending:");
  if (status.pending.length === 0) lines.push("  (none)");
  for (const migration of status.pending) {
    lines.push(`  ${String(migration.id).padStart(3)}  ${migration.description}`);
  }
  if (mode === "dry-run") lines.push("", "Dry run: nothing was changed.");
  return `${lines.join("\n")}\n`;
}
