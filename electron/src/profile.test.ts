import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { userDataDir } from "./profile.ts";

describe("userDataDir", () => {
  const appData = path.resolve("/Users/x/Library/Application Support");

  it("pins the packaged profile to the identifier, not to package.json", () => {
    assert.equal(userDataDir({ appData, isPackaged: true }), path.join(appData, "trackyourtime"));
  });

  it("keeps an unpackaged run out of the installed app's profile and lock", () => {
    assert.equal(userDataDir({ appData, isPackaged: false }), path.join(appData, "trackyourtime-dev"));
  });

  it("honours an explicit override either way", () => {
    for (const isPackaged of [true, false]) {
      assert.equal(userDataDir({ appData, isPackaged, override: "/tmp/p" }), path.resolve("/tmp/p"));
    }
    assert.equal(userDataDir({ appData, isPackaged: true, override: "" }), path.join(appData, "trackyourtime"));
  });

  it("never lets a headless run open the installed app's profile", () => {
    // Headless uses the mock keychain: the real session.bin would not decrypt
    // and would be deleted, signing the person out.
    assert.equal(
      userDataDir({ appData, isPackaged: true, headless: true }),
      path.join(appData, "trackyourtime-headless"),
    );
    assert.equal(
      userDataDir({ appData, isPackaged: false, headless: true }),
      path.join(appData, "trackyourtime-dev-headless"),
    );
    assert.equal(userDataDir({ appData, isPackaged: true, headless: true, override: "/tmp/p" }), path.resolve("/tmp/p"));
  });
});
