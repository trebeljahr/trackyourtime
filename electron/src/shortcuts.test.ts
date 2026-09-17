import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DESKTOP_SHORTCUTS } from "../../packages/shared/src/desktop-shortcuts.ts";
import { createMemoryRegistrar, createShortcutManager } from "./shortcuts.ts";

describe("createShortcutManager", () => {
  it("registers bound actions and runs the right one", () => {
    const registrar = createMemoryRegistrar();
    const fired: string[] = [];
    const manager = createShortcutManager(registrar, (action) => fired.push(action));
    const statuses = manager.apply({ ...DEFAULT_DESKTOP_SHORTCUTS, "open-palette": "Control+Alt+K" });
    assert.deepEqual(
      statuses.map((s) => [s.action, s.registered, s.problem]),
      [
        ["toggle-timer", true, null],
        ["new-timer", false, null],
        ["toggle-window", false, null],
        ["open-palette", true, null],
      ],
    );
    registrar.registered.get("Control+Alt+K")?.();
    registrar.registered.get("CommandOrControl+Alt+Shift+Space")?.();
    assert.deepEqual(fired, ["open-palette", "toggle-timer"]);
  });

  it("reports a chord somebody else holds as taken, not registered", () => {
    const registrar = createMemoryRegistrar();
    registrar.taken.add("CommandOrControl+Alt+Shift+Space");
    const manager = createShortcutManager(registrar, () => undefined);
    const [toggle] = manager.apply(DEFAULT_DESKTOP_SHORTCUTS);
    assert.equal(toggle?.registered, false);
    assert.equal(toggle?.problem, "taken");
  });

  it("reports a throwing registration as invalid", () => {
    const manager = createShortcutManager(
      {
        register: () => {
          throw new Error("conversion failure");
        },
        unregister: () => undefined,
      },
      () => undefined,
    );
    assert.equal(manager.apply(DEFAULT_DESKTOP_SHORTCUTS)[0]?.problem, "invalid");
  });

  it("re-registers on change and releases what it no longer binds", () => {
    const registrar = createMemoryRegistrar();
    const manager = createShortcutManager(registrar, () => undefined);
    manager.apply(DEFAULT_DESKTOP_SHORTCUTS);
    manager.apply({ ...DEFAULT_DESKTOP_SHORTCUTS, "toggle-timer": "Control+Alt+T" });
    assert.deepEqual([...registrar.registered.keys()], ["Control+Alt+T"]);
  });

  it("suspends everything while recording, and restores it", () => {
    const registrar = createMemoryRegistrar();
    const manager = createShortcutManager(registrar, () => undefined);
    manager.apply(DEFAULT_DESKTOP_SHORTCUTS);
    manager.suspend();
    assert.equal(registrar.registered.size, 0);
    assert.equal(manager.isSuspended(), true);
    // A change while suspended is kept and registered on resume.
    manager.apply({ ...DEFAULT_DESKTOP_SHORTCUTS, "new-timer": "Control+Alt+N" });
    assert.equal(registrar.registered.size, 0);
    manager.resume();
    assert.deepEqual([...registrar.registered.keys()].sort(), ["CommandOrControl+Alt+Shift+Space", "Control+Alt+N"]);
  });

  it("never unregisters a chord it did not register", () => {
    const registrar = createMemoryRegistrar();
    const foreign = () => undefined;
    registrar.registered.set("Control+Alt+X", foreign);
    registrar.taken.add("Control+Alt+X");
    const manager = createShortcutManager(registrar, () => undefined);
    manager.apply({ ...DEFAULT_DESKTOP_SHORTCUTS, "new-timer": "Control+Alt+X" });
    manager.dispose();
    assert.equal(registrar.registered.get("Control+Alt+X"), foreign);
  });
});
