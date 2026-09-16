// Every migration this build knows, in order. Append only: never edit, reorder
// or remove a released migration — databases out there have its id recorded.
import { baseline } from "./001-baseline.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [baseline];

/**
 * The newest schema this build understands: the id of its last migration.
 * A database whose applied migrations require a reader newer than this is
 * refused at boot.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.id ?? 0;

/**
 * Throws when the list is not 1…n in order, or a migration claims a reader
 * newer than itself. Run by the test suite and once by the runner, so a bad
 * append fails before it touches a database.
 */
export function assertMigrationSequence(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new Error(
        `migration at position ${index + 1} has id ${migration.id}; ids must be 1, 2, 3 … in order`,
      );
    }
    if (
      !Number.isInteger(migration.minReaderSchema) ||
      migration.minReaderSchema < 0 ||
      migration.minReaderSchema > migration.id
    ) {
      throw new Error(
        `migration ${migration.id} has minReaderSchema ${migration.minReaderSchema}; it must be an integer from 0 to its own id`,
      );
    }
  });
}
