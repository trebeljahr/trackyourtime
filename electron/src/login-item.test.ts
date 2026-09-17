import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createLinuxLoginItem,
  createMemoryLoginItem,
  isHiddenLaunch,
  linuxAutostartEntry,
  linuxAutostartPath,
  quoteExecArg,
} from "./login-item.ts";

describe("linux autostart", () => {
  it("quotes an Exec path with spaces and shell characters", () => {
    assert.equal(quoteExecArg("/opt/TrackYourTime/app"), "/opt/TrackYourTime/app");
    assert.equal(quoteExecArg("/home/a b/Track $Time`.AppImage"), '"/home/a b/Track \\$Time\\`.AppImage"');
  });

  it("writes an entry that launches hidden", () => {
    const entry = linuxAutostartEntry({ exec: "/home/me/Apps/Track Your Time.AppImage", name: "Track Your Time" });
    assert.match(entry, /^\[Desktop Entry\]\n/);
    assert.match(entry, /\nExec="\/home\/me\/Apps\/Track Your Time.AppImage" --hidden\n/);
  });

  it("honours an absolute XDG_CONFIG_HOME only", () => {
    assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/me"), "/x/cfg/autostart/trackyourtime.desktop");
    assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: "rel" }, "/home/me"), "/home/me/.config/autostart/trackyourtime.desktop");
  });

  it("round-trips enable and disable on a file", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "tyt-autostart-")), "autostart", "trackyourtime.desktop");
    const item = createLinuxLoginItem({ exec: "/opt/tyt", name: "Track Your Time", file });
    assert.equal(item.status(), "disabled");
    item.set(true);
    assert.equal(item.status(), "enabled");
    assert.match(readFileSync(file, "utf8"), /Exec=\/opt\/tyt --hidden/);
    item.set(false);
    assert.equal(item.status(), "disabled");
    // An entry written for another binary (a moved AppImage) is not ours.
    const moved = createLinuxLoginItem({ exec: "/opt/elsewhere", name: "Track Your Time", file });
    item.set(true);
    assert.equal(moved.status(), "disabled");
  });
});

describe("memory login item and hidden launch", () => {
  it("never reaches the OS", () => {
    const item = createMemoryLoginItem();
    item.set(true);
    assert.equal(item.status(), "enabled");
  });

  it("detects --hidden", () => {
    assert.equal(isHiddenLaunch(["/app", "--hidden"]), true);
    assert.equal(isHiddenLaunch(["/app"]), false);
  });
});
