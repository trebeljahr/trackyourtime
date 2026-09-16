// The shape of one migration and of what is stored once it has run.
import type { Db } from "mongodb";

export type Migration = {
  /**
   * Position in the sequence: 1, 2, 3 … with no gaps. The stored record is
   * keyed on it, so an id is never reused or renumbered once released.
   */
  id: number;
  /** One line for the log and `admin migrate --status`. */
  description: string;
  /**
   * The lowest `SCHEMA_VERSION` a build must have to still read the database
   * after this migration ran.
   *
   * Most migrations are additive (a backfill, a new index, a field older code
   * ignores) and keep this at a value every supported release already has —
   * `0` means "any release, including those from before the runner existed".
   * Only a migration that changes a shape older code misreads raises it to
   * its own id, which makes every older build refuse to start against the
   * database instead of quietly corrupting it.
   */
  minReaderSchema: number;
  /**
   * The change itself, against the raw driver so a migration never depends on
   * today's mongoose models (which will have moved on by the time an old
   * database runs it).
   *
   * MUST be idempotent: a process can die after `up` finished and before the
   * record was written, and the next boot runs it again.
   */
  up: (db: Db) => Promise<void>;
};

/** A row of `schema_migrations`. */
export type MigrationRecord = {
  _id: number;
  description: string;
  minReaderSchema: number;
  appliedAt: Date;
  /** The Track Your Time release that applied it (`env.RELEASE`). */
  release: string;
};

export type MigrationLogger = {
  log: (message: string) => void;
  error: (message: string) => void;
};
