// The opt-in update notice: which release counts as newest, when a notice is
// owed, what a check stores on success and failure, that the job does not
// exist unless the operator turned it on, and the doctor's release line.
// No network and no database: fetch and the collection are fakes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { checkVersion, type VersionState } from "../cli/doctor.js";
import { createJobRegistry } from "../services/scheduler/registry.js";
import {
  RELEASES_API_URL,
  UPDATE_CHECK_JOB,
  newestStableRelease,
  registerUpdateCheckJob,
  releaseNotesUrl,
  runUpdateCheck,
  updateNoticeFor,
  type StoredReleaseCheck,
} from "../services/update-check.js";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  ...extra,
});

/** An `app_meta` collection that applies `$set` and `$setOnInsert` to one row. */
const fakeDb = () => {
  let row: Record<string, unknown> | null = null;
  const collection = {
    updateOne: async (
      _filter: unknown,
      update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
    ) => {
      const inserting = row === null;
      row = { _id: "release-check", ...(row ?? {}), ...(inserting ? update.$setOnInsert : {}), ...update.$set };
      return {};
    },
    findOne: async () => row,
  };
  return { db: { collection: () => collection } as unknown as Db, row: () => row };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the newest release", () => {
  it("is the highest plain vX.Y.Z, ignoring drafts, prereleases and other tags", () => {
    assert.equal(
      newestStableRelease([
        release("v0.2.0"),
        release("v0.10.0"),
        release("v0.11.0", { draft: true }),
        release("v0.12.0-rc.1", { prerelease: true }),
        release("v1.0.0-rc.1"),
        release("nightly"),
      ]),
      "0.10.0",
    );
    assert.equal(newestStableRelease([]), null);
    assert.equal(newestStableRelease({ message: "rate limited" }), null);
  });
});

describe("the notice", () => {
  it("is owed only for a newer stable release", () => {
    assert.deepEqual(updateNoticeFor({ newestVersion: "0.2.0" }, "0.1.0"), {
      version: "0.2.0",
      releaseNotesUrl: "https://github.com/trebeljahr/trackyourtime/releases/tag/v0.2.0",
    });
    assert.equal(updateNoticeFor({ newestVersion: "0.1.0" }, "0.1.0"), null);
    assert.equal(updateNoticeFor({ newestVersion: "0.1.0" }, "0.2.0"), null);
    assert.equal(updateNoticeFor({ newestVersion: null }, "0.1.0"), null);
    assert.equal(updateNoticeFor(null, "0.1.0"), null);
    assert.equal(updateNoticeFor({ newestVersion: "0.2.0" }, ""), null, "a dev build is never behind");
    assert.equal(updateNoticeFor({ newestVersion: "0.2.0\"><script>" }, "0.1.0"), null);
  });

  it("links release notes built from the version alone", () => {
    assert.equal(releaseNotesUrl("1.2.3"), "https://github.com/trebeljahr/trackyourtime/releases/tag/v1.2.3");
  });
});

describe("a check", () => {
  it("asks GitHub's releases list and stores the newest stable release", async () => {
    const fake = fakeDb();
    const requested: string[] = [];
    const newest = await runUpdateCheck({
      db: fake.db,
      release: "0.1.0",
      now: () => new Date("2026-09-16T00:00:00Z"),
      fetchImpl: async (url) => {
        requested.push(String(url));
        return jsonResponse([release("v0.1.0"), release("v0.2.0")]);
      },
    });
    assert.equal(newest, "0.2.0");
    assert.deepEqual(requested, [RELEASES_API_URL]);
    const row = fake.row() as StoredReleaseCheck;
    assert.equal(row.newestVersion, "0.2.0");
    assert.equal(row.lastError, null);
  });

  it("keeps the last good answer when GitHub fails, and records why", async () => {
    const fake = fakeDb();
    await runUpdateCheck({ db: fake.db, release: "0.1.0", fetchImpl: async () => jsonResponse([release("v0.2.0")]) });
    await assert.rejects(
      runUpdateCheck({ db: fake.db, release: "0.1.0", fetchImpl: async () => jsonResponse({}, 403) }),
      /HTTP 403/,
    );
    const row = fake.row() as StoredReleaseCheck;
    assert.equal(row.newestVersion, "0.2.0");
    assert.match(row.lastError ?? "", /HTTP 403/);
  });

  it("registers a daily job under its own name", () => {
    const registry = createJobRegistry();
    registerUpdateCheckJob({ db: () => undefined, release: "0.1.0" }, registry);
    const [job] = registry.list();
    assert.equal(job?.name, UPDATE_CHECK_JOB);
    assert.equal(job?.intervalMs, 24 * 60 * 60 * 1000);
  });

  it("is off unless TRACKYOURTIME_UPDATE_CHECK says on, so no job exists by default", async () => {
    const { env, parseBooleanDefaultOff } = await import("../config/env.js");
    assert.equal(env.TRACKYOURTIME_UPDATE_CHECK, false);
    for (const on of ["true", "1", "yes", "ON"]) assert.equal(parseBooleanDefaultOff(on), true, on);
    for (const off of ["", "false", "0", "no", "maybe"]) assert.equal(parseBooleanDefaultOff(off), false, off);
    const { jobRegistry, registerBuiltInJobs } = await import("../services/scheduler/index.js");
    registerBuiltInJobs();
    assert.equal(jobRegistry.list().some((job) => job.name === UPDATE_CHECK_JOB), false);
  });
});

describe("doctor's release line", () => {
  const state = (overrides: Partial<VersionState> = {}): VersionState => ({
    release: "0.1.0",
    apiLevel: 2,
    schemaVersion: 1,
    updateCheck: false,
    ...overrides,
  });
  const stored = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    stored: {
      newestVersion: "0.1.0",
      checkedAt: new Date("2026-09-16T00:00:00Z"),
      succeededAt: new Date("2026-09-16T00:00:00Z"),
      lastError: null,
      ...overrides,
    },
  });

  it("prints release, API level and schema, and says the check is off", () => {
    const result = checkVersion(state(), null);
    assert.equal(result.status, "pass");
    assert.equal(result.detail, "release v0.1.0, API level 2, schema 1; update check off");
  });

  it("warns with the upgrade path when a newer release is stored", () => {
    const result = checkVersion(state({ updateCheck: true }), stored({ newestVersion: "0.2.0" }));
    assert.equal(result.status, "warn");
    assert.match(result.detail, /v0\.2\.0 is available \(checked 2026-09-16\)/);
    assert.match(result.fix ?? "", /releases\/tag\/v0\.2\.0.*Upgrading/);
  });

  it("passes when current, and warns when the last check failed", () => {
    assert.equal(checkVersion(state({ updateCheck: true }), stored()).status, "pass");
    assert.equal(checkVersion(state({ updateCheck: true }), { ok: true, stored: null }).status, "pass");
    const failed = checkVersion(state({ updateCheck: true }), stored({ lastError: "fetch failed" }));
    assert.equal(failed.status, "warn");
    assert.match(failed.fix ?? "", /api\.github\.com/);
  });
});
