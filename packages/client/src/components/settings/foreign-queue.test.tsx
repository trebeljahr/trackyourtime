// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type { ForeignQueuedRow } from "@/lib/offline";

/**
 * The panel is the only place in this client that deletes unsynced time, so
 * what these pin is that it cannot happen by accident: nothing is removed
 * until a person has seen what the rows are and confirmed a second time.
 */

const state = { foreign: 0 };
const rows: ForeignQueuedRow[] = [];
const discardForeignQueued = vi.fn(async (ids?: readonly string[]) =>
  ids === undefined ? rows.length : ids.length,
);

vi.mock("@/providers/offline-queue-provider", () => ({
  useOfflineQueueState: () => state,
}));

vi.mock("@/lib/offline", () => ({
  listForeignQueued: async () => rows,
  discardForeignQueued: (ids?: readonly string[]) => discardForeignQueued(ids),
}));

vi.mock("@/lib/api-origin", () => ({
  getAbsoluteApiOrigin: () => "https://api.trackyourtime.dev",
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { ForeignQueuePanel } = await import("./foreign-queue");

const setRows = (next: ForeignQueuedRow[]): void => {
  rows.length = 0;
  rows.push(...next);
  state.foreign = next.length;
};

beforeEach(() => {
  discardForeignQueued.mockClear();
  setRows([]);
});

afterEach(cleanup);

describe("ForeignQueuePanel", () => {
  it("renders nothing when this device holds nobody else's work", () => {
    const { container } = render(<ForeignQueuePanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names what each queued row was, so discarding is a real decision", async () => {
    setRows([
      {
        queueId: "1",
        op: "entries.start",
        description: "Design review",
        at: "2026-08-21T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
      {
        queueId: "2",
        op: "entries.stop",
        description: null,
        at: "2026-08-21T11:30:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
    ]);

    render(<ForeignQueuePanel />);

    expect(await screen.findByText(/Design review/)).toBeInTheDocument();
    expect(screen.getByText("Started a timer")).toBeInTheDocument();
    expect(screen.getByText("Stopped a timer")).toBeInTheDocument();
    expect(screen.getByTestId("foreign-queue-panel")).toHaveTextContent(
      "2 changes queued on this device",
    );
  });

  it("labels a row it can no longer decode rather than hiding it", async () => {
    setRows([
      {
        queueId: "1",
        op: null,
        description: null,
        at: "2026-08-21T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
    ]);
    render(<ForeignQueuePanel />);
    expect(await screen.findByText("Unrecognised change")).toBeInTheDocument();
  });

  it("does not delete anything until the confirmation is accepted", async () => {
    setRows([
      {
        queueId: "1",
        op: "entries.start",
        description: "Design review",
        at: "2026-08-21T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
    ]);

    render(<ForeignQueuePanel />);
    await screen.findByTestId("foreign-queue-discard");

    fireEvent.click(screen.getByTestId("foreign-queue-discard"));
    expect(discardForeignQueued).not.toHaveBeenCalled();

    // The confirmation has to say what is being destroyed and that it is gone
    // for good — "1 change" is not something anybody can decide about.
    const confirm = await screen.findByTestId("foreign-queue-confirm");
    expect(confirm).toHaveTextContent("no server has ever received");

    fireEvent.click(screen.getByTestId("foreign-queue-cancel"));
    expect(discardForeignQueued).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("foreign-queue-discard"));
    fireEvent.click(await screen.findByTestId("foreign-queue-confirm-discard"));
    await waitFor(() => expect(discardForeignQueued).toHaveBeenCalledTimes(1));
  });

  it("keeps another server's rows apart, and discards only the group confirmed", async () => {
    setRows([
      {
        queueId: "a1",
        op: "entries.start",
        description: "Design review",
        at: "2026-08-21T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
      {
        queueId: "s1",
        op: "entries.create",
        description: "Invoicing",
        at: "2026-08-22T09:00:00.000Z",
        server: "https://track.example.com",
        otherServer: "https://track.example.com",
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
      {
        queueId: "s2",
        op: "entries.stop",
        description: null,
        at: "2026-08-22T10:00:00.000Z",
        server: "https://track.example.com",
        otherServer: "https://track.example.com",
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
    ]);

    render(<ForeignQueuePanel />);
    await screen.findByText(/Invoicing/);

    const groups = screen.getAllByTestId("foreign-queue-group");
    expect(groups).toHaveLength(2);
    const [account, server] = groups as [HTMLElement, HTMLElement];
    expect(account).toHaveTextContent("Unsynced data from another account");
    expect(server).toHaveTextContent("Unsynced data for track.example.com");
    // Says where they would NOT go, by name — not "another server".
    expect(server).toHaveTextContent("not sent to Track Your Time cloud");
    expect(server).toHaveTextContent("Switch this device back to track.example.com");

    fireEvent.click(within(server).getByTestId("foreign-queue-discard"));
    const confirm = await screen.findByTestId("foreign-queue-confirm");
    expect(confirm).toHaveTextContent("Discard 2 unsynced changes?");
    expect(confirm).toHaveTextContent("switching back to track.example.com");

    fireEvent.click(screen.getByTestId("foreign-queue-confirm-discard"));
    await waitFor(() =>
      expect(discardForeignQueued).toHaveBeenCalledWith(["s1", "s2"]),
    );
  });

  it("names a left workspace's rows by workspace, and discards only that group", async () => {
    setRows([
      {
        queueId: "w1",
        op: "entries.start",
        description: "Retainer call",
        at: "2026-09-10T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: "ws-acme",
        workspaceName: "Acme",
        leftWorkspace: true,
      },
      {
        queueId: "w2",
        op: "entries.create",
        description: "Old work",
        at: "2026-09-11T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: "ws-gone",
        workspaceName: null,
        leftWorkspace: true,
      },
      {
        queueId: "a1",
        op: "entries.start",
        description: "Design review",
        at: "2026-08-21T09:00:00.000Z",
        server: null,
        otherServer: null,
        workspaceId: null,
        workspaceName: null,
        leftWorkspace: false,
      },
    ]);

    render(<ForeignQueuePanel />);
    await screen.findByText(/Retainer call/);

    const groups = screen.getAllByTestId("foreign-queue-group");
    expect(groups).toHaveLength(3);
    const acme = groups.find((group) => group.dataset.workspaceId === "ws-acme");
    const gone = groups.find((group) => group.dataset.workspaceId === "ws-gone");
    if (!acme || !gone) throw new Error("workspace groups missing");
    expect(acme).toHaveTextContent("Unsynced data for Acme");
    expect(acme).toHaveTextContent("not sent to any other workspace");
    expect(gone).toHaveTextContent("Unsynced data for a workspace you left");

    fireEvent.click(within(acme).getByTestId("foreign-queue-discard"));
    const confirm = await screen.findByTestId("foreign-queue-confirm");
    expect(confirm).toHaveTextContent("tracked in Acme");
    fireEvent.click(screen.getByTestId("foreign-queue-confirm-discard"));
    await waitFor(() =>
      expect(discardForeignQueued).toHaveBeenCalledWith(["w1"]),
    );
  });
});
