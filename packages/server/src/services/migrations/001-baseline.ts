import type { Migration } from "./types.js";

/**
 * Records that a database existed when the runner was introduced. Changes
 * nothing: every document written by earlier releases already follows the
 * "absent field reads as its default" convention, so there is nothing to
 * rewrite. Readable by every release, including those without a runner.
 */
export const baseline: Migration = {
  id: 1,
  description: "baseline: record the schema as of the first release with a migration runner",
  minReaderSchema: 0,
  up: async () => {},
};
