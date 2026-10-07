// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ForeignQueuedRow } from "@/lib/offline";

const retry = vi.fn(async (_id: string, _input?: unknown) => 1);
const exporting = vi.fn(async (_ids: readonly string[]) => '{"v":1,"data":[]}');
const flush = vi.fn(async () => undefined);
const download = vi.fn();
const listTargets = vi.fn(async () => ({
  entries: [
    {
      id: "original-entry",
      description: "Original meeting",
      start: "2026-10-01T09:00:00Z",
    },
  ],
}));
vi.mock("@/lib/trpc", () => ({
  trpc: { useUtils: () => ({ entries: { list: { fetch: listTargets } } }) },
}));
vi.mock("@/lib/offline", () => ({
  retryQueuedRecovery: (...args: unknown[]) =>
    retry(...(args as [string, unknown?])),
  exportQueuedRecovery: (ids: readonly string[]) => exporting(ids),
  queuedRecoveryTargetInput: async () => ({ row: {}, input: {} }),
  filterQueuedRecoveryTargets: (entries: unknown) => entries,
}));
vi.mock("@/lib/download", () => ({
  downloadBlob: (...args: unknown[]) => download(...args),
}));

vi.mock("@/providers/offline-queue-provider", () => ({
  useOfflineQueueState: () => ({ flush }),
}));
const { QueueRecovery } = await import("./queue-recovery");
const row: ForeignQueuedRow = {
  queueId: "queue-1",
  op: "entries.update",
  description: "meeting",
  at: "2026-10-01T09:00:00Z",
  server: "https://time.example",
  workspaceId: "work-a",
  workspaceName: "Work",
  hold: "refused",
  otherServer: null,
  leftWorkspace: false,
  recovery: {
    input: { id: "entry-1", description: "meeting" },
    originalPayload: { input: { description: "meeting" } },
    code: "FORBIDDEN",
    message: "Role changed",
  },
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("owner can review original work, repair fields, retry and download a fresh scoped export", async () => {
  render(<QueueRecovery row={row} />);
  expect(screen.getByText(/Role changed/)).toBeInTheDocument();
  expect(screen.getByText(/Original change/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Repair fields"));
  fireEvent.change(screen.getByTestId("queue-recovery-description"), {
    target: { value: "corrected" },
  });
  fireEvent.click(screen.getByTestId("queue-recovery-retry"));
  await waitFor(() =>
    expect(retry).toHaveBeenCalledWith("queue-1", {
      id: "entry-1",
      description: "corrected",
    }),
  );
  await waitFor(() => expect(flush).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId("queue-recovery-export"));
  await waitFor(() => expect(exporting).toHaveBeenCalledWith(["queue-1"]));
  await waitFor(() =>
    expect(download).toHaveBeenCalledWith(
      "trackyourtime-unsynced.json",
      expect.any(Blob),
    ),
  );
});

test("a foreign payload exposes no recovery controls", () => {
  render(
    <QueueRecovery row={{ ...row, recovery: undefined, description: null }} />,
  );
  expect(screen.queryByTestId("queue-recovery")).not.toBeInTheDocument();
});

test("invalid repair JSON reports failure without retry or flush", async () => {
  render(<QueueRecovery row={row} />);
  fireEvent.click(screen.getByText("Repair fields"));
  fireEvent.click(screen.getByLabelText(/Use advanced JSON/));
  fireEvent.change(screen.getByTestId("queue-recovery-input"), {
    target: { value: "bad json" },
  });
  fireEvent.click(screen.getByTestId("queue-recovery-retry"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/Enter valid JSON/),
  );
  expect(retry).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});

test("ordinary repair clears deleted selections without entering IDs or JSON", async () => {
  const input = {
    description: "meeting",
    start: "2026-10-01T09:00:00Z",
    end: "2026-10-01T10:00:00Z",
    projectId: "deleted",
    taskId: "deleted",
    clientId: "deleted",
    tagIds: ["deleted"],
  };
  render(
    <QueueRecovery
      row={{
        ...row,
        op: "entries.create",
        recovery: { input, originalPayload: { input } },
      }}
    />,
  );
  fireEvent.click(screen.getByText("Repair fields"));
  fireEvent.click(screen.getByTestId("queue-recovery-clear-catalog"));
  fireEvent.change(screen.getByTestId("queue-recovery-description"), {
    target: { value: "corrected" },
  });
  fireEvent.click(screen.getByTestId("queue-recovery-retry"));
  await waitFor(() =>
    expect(retry).toHaveBeenCalledWith("queue-1", {
      ...input,
      description: "corrected",
      projectId: null,
      taskId: null,
      clientId: null,
      tagIds: [],
    }),
  );
});

test("backward date range shows actionable validation and sends nothing", async () => {
  const input = {
    description: "meeting",
    start: "2026-10-01T09:00:00Z",
    end: "2026-10-01T10:00:00Z",
  };
  render(
    <QueueRecovery
      row={{
        ...row,
        op: "entries.create",
        recovery: { input, originalPayload: { input } },
      }}
    />,
  );
  fireEvent.click(screen.getByText("Repair fields"));
  fireEvent.change(screen.getByTestId("queue-recovery-end"), {
    target: { value: "2020-01-01T08:00:00" },
  });
  fireEvent.click(screen.getByTestId("queue-recovery-retry"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "End must be after start",
    ),
  );
  expect(retry).not.toHaveBeenCalled();
});

test("an orphan stop needs an explicit entry selected by name", async () => {
  const input = { end: "2026-10-01T10:00:00Z" };
  render(
    <QueueRecovery
      row={{
        ...row,
        op: "entries.stop",
        hold: "stale-stop",
        recovery: { input, originalPayload: { input }, needsStopTarget: true },
      }}
    />,
  );
  fireEvent.click(screen.getByTestId("queue-recovery-retry"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose the original entry",
    ),
  );
  expect(retry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Repair fields"));
  fireEvent.click(screen.getByText("Find entries around this stop"));
  await screen.findByRole("option", { name: /Original meeting/ });
  fireEvent.change(screen.getByTestId("queue-recovery-target"), {
    target: { value: "original-entry" },
  });
  fireEvent.click(screen.getByTestId("queue-recovery-retry"));
  await waitFor(() =>
    expect(retry).toHaveBeenCalledWith("queue-1", {
      ...input,
      id: "original-entry",
    }),
  );
});

test("a row waiting for a server update shows one line, the original change and a copy — no repair, no retry", () => {
  render(
    <QueueRecovery
      row={{
        ...row,
        op: "entries.start",
        hold: "server-too-old",
        recovery: {
          input: { description: "Computer Demos" },
          originalPayload: { input: { description: "Computer Demos" } },
        },
      }}
    />,
  );
  expect(
    screen.getByText("Sends automatically after the server update"),
  ).toBeInTheDocument();
  expect(screen.getByText(/Original change/)).toBeInTheDocument();
  expect(screen.queryByText("Repair fields")).toBeNull();
  expect(screen.queryByTestId("queue-recovery-retry")).toBeNull();
  expect(screen.queryByText(/Your work is saved here/)).toBeNull();
  expect(
    screen.getByTestId("queue-recovery-export").closest("details"),
  ).not.toBeNull();
});
