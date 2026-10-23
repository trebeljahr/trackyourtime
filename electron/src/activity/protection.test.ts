import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { activityAccount, activityProtection, createActivityCodec, finishActivitySwap, protectActivity, recoverActivitySwap, verifyActivityProtection } from "./protection.ts";
import { createActivityStore, dayFileOf } from "./store.ts";
import { DEFAULT_ACTIVITY_SETTINGS } from "./settings.ts";
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "tyt-private-activity-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const account = activityAccount("user", "https://example.test");
const scope = "user:workspace", at = Date.UTC(2026, 9, 23);
function fixture() {
  const store = createActivityStore(dir);
  store.saveState({ ...DEFAULT_ACTIVITY_SETTINGS, enabled: true, storeTitles: true }, scope);
  store.append({ scope, start: at, end: at + 10000, source: "desktop", afk: false, key: "secret.app", name: "Private app", label: "Confidential client" });
  store.putRule(scope, { id: "rule", pattern: "secret.app", description: "Private work" }, at);
  return store;
}
describe("encrypted local activity", () => {
  it("migrates and verifies every source file, then reads/writes only ciphertext", () => {
    const before = fixture().files(), key = randomBytes(32), codec = createActivityCodec(key, account);
    protectActivity(dir, codec, account);
    assert.deepEqual(activityProtection(dir), { account });
    assert.equal(existsSync(path.join(dir, "activity.previous")), false);
    assert.deepEqual(createActivityStore(dir, Date.now, codec).files(), before);
    const backupText = codec.decode(readFileSync(path.join(dir, "activity/migration-backup.bin"), "utf8"), "migration-backup.bin");
    const backup = JSON.parse(backupText) as Record<string, string>;
    assert.match(backup[`segments/${dayFileOf(at)}`]!, /Confidential client/);
    const reopened = createActivityStore(dir, Date.now, codec);
    reopened.writeOpen({ scope, key: "secret.app", name: "Private app", label: "Confidential client", start: at, lastSeen: at });
    reopened.addDismissal(scope, { start: at, end: at + 1000 });
    reopened.append({ scope, start: at + 20000, end: at + 30000, source: "desktop", afk: false, key: "another.secret", name: "Other" });
    verifyActivityProtection(dir, codec);
    for (const entry of readdirSync(path.join(dir, "activity"), { recursive: true, withFileTypes: true })) if (entry.isFile()) {
      const content = readFileSync(path.join(entry.parentPath, entry.name), "utf8");
      assert.doesNotMatch(content, /Confidential client|Private work|secret\.app|another\.secret|user:workspace/);
    }
    assert.equal(existsSync(path.join(dir, "activity/migration-backup.bin")), false);
    assert.equal(reopened.allSegments(scope).length, 2);
    assert.equal(reopened.readOpen()?.label, "Confidential client");
  });
  it("stays read-only without the key and rejects wrong keys, accounts, files and tampering", () => {
    fixture(); const key = randomBytes(32), codec = createActivityCodec(key, account); protectActivity(dir, codec, account);
    const locked = createActivityStore(dir), statePath = path.join(dir, "activity/state.json"), before = readFileSync(statePath, "utf8");
    assert.equal(locked.status, "locked"); assert.deepEqual(locked.allSegments(scope), []);
    locked.wipe(); locked.saveState(DEFAULT_ACTIVITY_SETTINGS, "intruder:workspace"); assert.equal(readFileSync(statePath, "utf8"), before);
    assert.throws(() => verifyActivityProtection(dir, createActivityCodec(randomBytes(32), account)));
    assert.throws(() => verifyActivityProtection(dir, createActivityCodec(key, activityAccount("other", "https://example.test"))));
    assert.throws(() => codec.decode(before, "open.json"));
    const box = JSON.parse(before); box.tag = Buffer.alloc(16).toString("base64url");
    assert.throws(() => codec.decode(JSON.stringify(box), "state.json"));
    codec.destroy(); assert.throws(() => codec.decode(before, "state.json"));
  });
  it("recovers an interrupted final encrypted append without losing readable history", () => {
    fixture(); const codec = createActivityCodec(randomBytes(32), account); protectActivity(dir, codec, account);
    const file = path.join(dir, "activity/segments", dayFileOf(at));
    appendFileSync(file, '{"v":2,"data":"interrupted');
    assert.throws(() => verifyActivityProtection(dir, codec));
    finishActivitySwap(dir, codec);
    const store = createActivityStore(dir, Date.now, codec);
    assert.equal(store.allSegments(scope).length, 1);
    const saved = readdirSync(path.dirname(file)).find((name) => name.includes(".torn."));
    assert.ok(saved);
    assert.equal(codec.decode(readFileSync(path.join(path.dirname(file), saved), "utf8"), `segments/${saved}`), '{"v":2,"data":"interrupted');
    store.append({ scope, start: at + 30000, end: at + 40000, source: "desktop", afk: false, key: "app", name: "App" });
    verifyActivityProtection(dir, codec);
    assert.equal(readdirSync(path.dirname(file)).some((name) => name.includes(".torn.")), false);
    assert.equal(createActivityStore(dir, Date.now, codec).allSegments(scope).length, 2);
  });
  it("preserves source bytes and repairs an interrupted directory swap", () => {
    fixture(); const old = readFileSync(path.join(dir, "activity/state.json"), "utf8");
    renameSync(path.join(dir, "activity"), path.join(dir, "activity.previous")); recoverActivitySwap(dir);
    assert.equal(readFileSync(path.join(dir, "activity/state.json"), "utf8"), old);
    const codec = createActivityCodec(randomBytes(32), account); protectActivity(dir, codec, account);
    // A crash after the new folder was installed keeps the original until
    // the successor's key and all ciphertext have been verified.
    const other = path.join(dir, "activity.previous");
    writeFileSync(path.join(dir, "old-copy"), "source");
    renameSync(path.join(dir, "old-copy"), other);
    assert.throws(() => finishActivitySwap(dir, createActivityCodec(randomBytes(32), account)));
    assert.equal(existsSync(other), true);
    finishActivitySwap(dir, codec); assert.equal(existsSync(other), false);
  });
});
