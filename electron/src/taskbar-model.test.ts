import assert from "node:assert/strict";
import { it } from "node:test";
import { requestedWindowMode, windowsUserTasks } from "./taskbar-model.ts";

const input = {
  platform: "win32",
  isPackaged: true,
  headless: false,
  execPath: "C:\\Program Files\\Track Your Time\\Track Your Time.exe",
  labels: { open: "Open app", compactTimer: "Compact timer" },
};
it("gives packaged Windows two explicit recovery tasks without relying on the tray", () => {
  const tasks = windowsUserTasks(input)!;
  assert.equal(tasks[0].program, input.execPath);
  assert.deepEqual(
    tasks.map((task) => [task.title, requestedWindowMode([task.arguments])]),
    [
      ["Open app", "full"],
      ["Compact timer", "compact"],
    ],
  );
});
it("never changes native taskbar tasks in tests, development or other platforms", () => {
  for (const changes of [
    { headless: true },
    { isPackaged: false },
    { platform: "linux" },
    { platform: "darwin" },
  ]) {
    assert.equal(windowsUserTasks({ ...input, ...changes }), null);
  }
  assert.equal(requestedWindowMode(["--compact-timer=unexpected"]), null);
});
