// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTranslator } from "use-intl/core";
import { extensionMessages } from "../i18n";
import type { HeldSyncRow } from "../lib/messaging";
import { QueueRecovery } from "./queue-recovery";

const t = createTranslator({
  locale: "en",
  messages: extensionMessages.en,
  namespace: "popup",
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const click = async (label: string): Promise<void> => {
  const button = Array.from(host.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  expect(button).not.toBeUndefined();
  await act(async () => button!.click());
};
const type = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const input = {
  description: "original",
  start: "2026-10-01T09:00:00Z",
  end: "2026-10-01T10:00:00Z",
  projectId: "gone",
  taskId: "gone",
  clientId: "gone",
  tagIds: ["gone"],
};
const row: HeldSyncRow = {
  queueId: "q",
  op: "entries.create",
  description: "original",
  at: input.start,
  workspaceId: "w",
  workspaceName: "Work",
  server: "https://time.example",
  hold: "refused",
  recovery: { input, originalPayload: { input }, message: "Project gone" },
};

test("ordinary extension controls repair description and clear deleted selections", async () => {
  const retry = vi.fn(async () => true);
  await act(async () =>
    root.render(<QueueRecovery row={row} onRetry={retry} t={t} />),
  );
  await click("Repair fields");
  const description =
    host.querySelector<HTMLInputElement>("input:not([type])")!;
  await act(async () => type(description, "corrected"));
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click("Retry this chain");
  expect(retry).toHaveBeenCalledExactlyOnceWith("q", {
    ...input,
    description: "corrected",
    projectId: null,
    clientId: null,
    taskId: null,
    tagIds: [],
  });
});

test("date validation is actionable and does not invoke recovery", async () => {
  const retry = vi.fn(async () => true);
  await act(async () =>
    root.render(<QueueRecovery row={row} onRetry={retry} t={t} />),
  );
  await click("Repair fields");
  const dates = host.querySelectorAll<HTMLInputElement>(
    'input[type="datetime-local"]',
  );
  await act(async () => type(dates[1], "2020-01-01T10:00:00"));
  await click("Retry this chain");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "End must be after start",
  );
  expect(retry).not.toHaveBeenCalled();
});

test("unknown future operations remain export-only", async () => {
  await act(async () =>
    root.render(
      <QueueRecovery
        row={{ ...row, op: null, hold: "unknown-op" }}
        onRetry={async () => true}
        onExport={async () => "{}"}
        t={t}
      />,
    ),
  );
  expect(host.textContent).toContain("Download a copy");
  expect(host.textContent).not.toContain("Repair fields");
  expect(host.textContent).not.toContain("Retry this chain");
});

test("a row waiting for a server update is compact: no repair, no retry", async () => {
  const exported = vi.fn(async () => "{}");
  await act(async () =>
    root.render(
      <QueueRecovery
        row={{ ...row, op: "entries.start", hold: "server-too-old", recovery: { input, originalPayload: { input } } }}
        onRetry={async () => true}
        onExport={exported}
        t={t}
      />,
    ),
  );
  expect(host.textContent).toContain("Sends automatically after the server update");
  expect(host.textContent).toContain("Original change");
  expect(host.textContent).not.toContain("Repair fields");
  expect(host.textContent).not.toContain("Retry this chain");
  expect(host.textContent).not.toContain("Your work is saved here");
  // The copy sits inside the collapsed original change.
  const download = Array.from(host.querySelectorAll("details button")).find(
    (button) => button.textContent === "Download a copy",
  );
  expect(download).not.toBeUndefined();
});
