// The optional update notice: once a day, ask GitHub which Track Your Time
// release is newest, and tell a workspace's owners and admins when it is newer
// than this server.
//
// OFF unless TRACKYOURTIME_UPDATE_CHECK is set. With it off this module makes
// no request and registers no job, so a self-hosted server opens no connection
// outside its own stack. Nothing here ever updates anything: the answer is one
// line in Settings with a link to the release notes and the Upgrading guide.
//
// The result lives in `app_meta` (the collection the migration lock uses)
// under its own id, read by `settings.updateNotice` and `admin doctor`, so
// neither of them calls GitHub itself.
import type { Db } from "mongodb";
import { compareVersions } from "@starter/shared";
import { APP_META_COLLECTION } from "./migrations/lease.js";
import { jobRegistry, type JobRegistry } from "./scheduler/registry.js";

export const UPDATE_CHECK_JOB = "update-check";

/** Once a day. The scheduler's lease makes it once a day across processes. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const RELEASES_API_URL =
  "https://api.github.com/repos/trebeljahr/trackyourtime/releases?per_page=100";

/** Built from the version, never taken from the API response. */
export const releaseNotesUrl = (version: string): string =>
  `https://github.com/trebeljahr/trackyourtime/releases/tag/v${version}`;

const RELEASE_CHECK_ID = "release-check";
const FETCH_TIMEOUT_MS = 10_000;
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The `app_meta` row. */
export type StoredReleaseCheck = {
  _id: typeof RELEASE_CHECK_ID;
  /** Newest stable release GitHub listed, without the `v`; null if none. */
  newestVersion: string | null;
  /** The last attempt, successful or not. */
  checkedAt: Date;
  /** The last successful answer. */
  succeededAt: Date | null;
  /** Why the last attempt failed, or null. */
  lastError: string | null;
};

export type UpdateNotice = { version: string; releaseNotesUrl: string };

/**
 * The newest stable `vX.Y.Z` in a GitHub releases listing. Drafts,
 * prereleases and any tag that is not plain `vX.Y.Z` are ignored.
 */
export function newestStableRelease(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  let newest: string | null = null;
  for (const item of body) {
    if (typeof item !== "object" || item === null) continue;
    const { tag_name: tag, draft, prerelease } = item as Record<string, unknown>;
    if (draft === true || prerelease === true || typeof tag !== "string") continue;
    const match = STABLE_TAG.exec(tag);
    if (!match) continue;
    const version = match[1] as string;
    if (newest === null || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

/** The notice to show against `currentRelease`, or null when there is none. */
export function updateNoticeFor(
  stored: Pick<StoredReleaseCheck, "newestVersion"> | null,
  currentRelease: string,
): UpdateNotice | null {
  const newest = stored?.newestVersion ?? null;
  if (newest === null || !STABLE_TAG.test(`v${newest}`)) return null;
  // A development build reports no release; it is never "behind".
  if (!/^\d+\.\d+\.\d+/.test(currentRelease)) return null;
  if (compareVersions(newest, currentRelease) <= 0) return null;
  return { version: newest, releaseNotesUrl: releaseNotesUrl(newest) };
}

export type UpdateCheckDeps = {
  db: Db;
  release: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * Ask GitHub once and store the answer. A failed attempt keeps the last good
 * `newestVersion`, records why, and rethrows so the scheduler logs it.
 */
export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = (deps.now ?? (() => new Date()))();
  const collection = deps.db.collection<StoredReleaseCheck>(APP_META_COLLECTION);
  try {
    const response = await doFetch(RELEASES_API_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `trackyourtime-server/${deps.release || "unknown"}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
    const newest = newestStableRelease(await response.json());
    await collection.updateOne(
      { _id: RELEASE_CHECK_ID },
      { $set: { newestVersion: newest, checkedAt: now, succeededAt: now, lastError: null } },
      { upsert: true },
    );
    return newest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await collection
      .updateOne(
        { _id: RELEASE_CHECK_ID },
        {
          $set: { checkedAt: now, lastError: message },
          $setOnInsert: { newestVersion: null, succeededAt: null },
        },
        { upsert: true },
      )
      .catch(() => undefined);
    throw error;
  }
}

/** The stored answer, or null when no check has run. */
export async function readReleaseCheck(db: Db): Promise<StoredReleaseCheck | null> {
  return db.collection<StoredReleaseCheck>(APP_META_COLLECTION).findOne({ _id: RELEASE_CHECK_ID });
}

export function registerUpdateCheckJob(
  deps: { db: () => Db | undefined; release: string },
  registry: JobRegistry = jobRegistry,
): void {
  registry.register(UPDATE_CHECK_JOB, UPDATE_CHECK_INTERVAL_MS, async () => {
    const db = deps.db();
    if (!db) throw new Error("the database is not connected");
    await runUpdateCheck({ db, release: deps.release });
  }, { leaseMs: 5 * 60 * 1000 });
}
