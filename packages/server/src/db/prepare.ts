// The database steps between connecting and serving: migrations, then
// indexes. Both must finish before `listen`, so no request ever runs against a
// schema this build has not checked.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { allModels } from "../models/registry.js";
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from "../services/migrations/index.js";
import { buildModelIndexes, describeIndex, reportIndexOutcomes } from "./indexes.js";

/**
 * A reason the server must not start, stated for the operator. `index.ts`
 * prints only the message for these; a stack trace would bury the sentence.
 */
export class BootRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootRefusedError";
  }
}

export async function prepareDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("prepareDatabase() needs a connected mongoose");

  // Migrations first: one may remove the duplicates a unique index below
  // would otherwise fail on.
  const applied = await runMigrations({
    db,
    migrations: MIGRATIONS,
    schemaVersion: SCHEMA_VERSION,
    owner: `${hostname()}:${process.pid}:${randomUUID()}`,
    release: env.RELEASE,
    logger: console,
  });
  console.log(
    applied.length > 0
      ? `[migrations] Schema ${SCHEMA_VERSION}; applied ${applied.join(", ")}`
      : `[migrations] Schema ${SCHEMA_VERSION}; nothing to apply`,
  );

  const fatal = reportIndexOutcomes(await buildModelIndexes(allModels()), console);
  if (fatal.length > 0) {
    throw new BootRefusedError(
      `[db] Refusing to start: ${fatal.map(describeIndex).join("; ")} could not be built, ` +
        "so the invariant it enforces is not guaranteed. The usual cause is duplicate documents; " +
        "see docs/self-hosting.md → Migrations.",
    );
  }
}
