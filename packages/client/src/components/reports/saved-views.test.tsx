// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "@starter/core";
import { createSavedReportStore } from "@/lib/saved-report-views";
import type { UseReportFiltersResult } from "./use-report-filters";

let userId = "user";
const push = vi.fn();
const records = new Map<string, string>();
let readFails = false;
let writeFails = false;
let delayWrite: Promise<void> | null = null;
const storage: KeyValueStorage = {
  getItem: async (key) => { if (readFails) throw Error("storage unavailable"); return records.get(key) ?? null; },
  setItem: async (key, value) => { if (writeFails) throw Error("disk full"); if (delayWrite) await delayWrite; records.set(key, value); },
  removeItem: async (key) => { records.delete(key); },
};
vi.mock("@/lib/entry-links", () => ({ useTrackedSpan: () => null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: userId } }) }));
vi.mock("@/components/workspace-switcher", () => ({ useActiveWorkspace: () => ({ activeId: "workspace" }) }));
vi.mock("@/lib/active-workspace", () => ({ getKnownWorkspacesOwner: () => userId }));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => "https://time.example" }));
vi.mock("@/lib/saved-report-views", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/saved-report-views")>()), savedReportStorage: () => storage }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams("preset=today&view=entries&tasks=task") }));
import { SavedReportViews } from "./saved-views";

const filters = { weekStartsOn: 1, state: { range: { from: "2026-10-03", to: "2026-10-03" } } } as UseReportFiltersResult;
const store = (id = userId) => createSavedReportStore({ userId: id, workspaceId: "workspace", server: "https://time.example" }, storage);
beforeEach(() => { userId = "user"; records.clear(); readFails = false; writeFails = false; delayWrite = null; push.mockClear(); });
afterEach(cleanup);

async function ready(): Promise<void> { await waitFor(() => expect(screen.getByTestId("saved-report-name")).toBeEnabled()); }

describe("saved view controls", () => {
  it("saves, reloads, loads, renames and deletes a named view", async () => {
    const rendered = render(<SavedReportViews filters={filters} />); await ready();
    fireEvent.change(screen.getByTestId("saved-report-name"), { target: { value: "Daily tasks" } });
    fireEvent.click(screen.getByTestId("saved-report-save"));
    await waitFor(async () => expect((await store().load())[0]?.name).toBe("Daily tasks"));
    rendered.unmount(); render(<SavedReportViews filters={filters} />); await ready();
    const view = (await store().load())[0]!;
    fireEvent.change(screen.getByTestId("saved-report-select"), { target: { value: view.id } });
    expect(push.mock.calls[0]?.[0]).toContain("view=entries"); expect(push.mock.calls[0]?.[0]).toContain("tasks=task");
    fireEvent.click(screen.getByTestId("saved-report-load")); expect(push).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByTestId("saved-report-name"), { target: { value: "Daily work" } });
    fireEvent.click(screen.getByTestId("saved-report-rename"));
    await waitFor(async () => expect((await store().load())[0]?.name).toBe("Daily work"));
    fireEvent.click(screen.getByTestId("saved-report-delete"));
    await waitFor(async () => expect(await store().load()).toEqual([]));
  });
  it("blocks writes after read failure and retries the read", async () => {
    readFails = true; render(<SavedReportViews filters={filters} />);
    await screen.findByRole("alert"); expect(screen.getByTestId("saved-report-save")).toBeDisabled();
    readFails = false; fireEvent.click(screen.getByText("Retry")); await ready();
  });
  it("keeps the existing view and draft when persistent writes fail", async () => {
    await store().write([{ id: "old", name: "Existing", query: "preset=today" }]);
    render(<SavedReportViews filters={filters} />); await ready(); writeFails = true;
    fireEvent.change(screen.getByTestId("saved-report-name"), { target: { value: "New" } });
    fireEvent.click(screen.getByTestId("saved-report-save"));
    await waitFor(() => expect(screen.getByTestId("saved-report-save")).toBeEnabled());
    expect((await store().load()).map((view) => view.name)).toEqual(["Existing"]);
    expect(screen.getByTestId("saved-report-name")).toHaveValue("New");
  });
  it("does not leak a late storage answer or the old account's draft after account switch", async () => {
    let resolve!: () => void;
    delayWrite = new Promise<void>((done) => { resolve = done; });
    const rendered = render(<SavedReportViews filters={filters} />); await ready();
    fireEvent.change(screen.getByTestId("saved-report-name"), { target: { value: "Private" } });
    fireEvent.click(screen.getByTestId("saved-report-save"));
    userId = "other"; rendered.rerender(<SavedReportViews filters={filters} />); await ready();
    expect(screen.getByTestId("saved-report-name")).toHaveValue("");
    await act(async () => resolve());
    expect(await store("other").load()).toEqual([]);
    expect((await store("user").load())[0]?.name).toBe("Private");
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
  });
});
