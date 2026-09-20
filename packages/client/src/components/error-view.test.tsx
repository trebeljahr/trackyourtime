// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let shell = false;
const reloadOnce = vi.fn(() => true);

vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => (shell ? "electron" : "web")),
);
vi.mock("@/lib/chunk-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chunk-reload")>()),
  reloadOnceForChunkError: () => reloadOnce(),
}));

const { ErrorView } = await import("./error-view");

const chunkError = (): Error => {
  const error = new Error("Loading chunk 12 failed.");
  error.name = "ChunkLoadError";
  return error;
};

beforeEach(() => {
  shell = false;
  reloadOnce.mockClear();
});
afterEach(cleanup);

describe("ErrorView", () => {
  it("reloads once on a chunk error on the web, and still offers Reload", () => {
    render(<ErrorView error={chunkError()} reset={() => undefined} />);
    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("error-view-reload")).toBeInTheDocument();
    expect(screen.queryByTestId("error-view-retry")).toBeNull();
  });

  it("never reloads by itself inside a shell", () => {
    shell = true;
    render(<ErrorView error={chunkError()} reset={() => undefined} />);
    expect(reloadOnce).not.toHaveBeenCalled();
  });

  it("offers Try again for any other error and reloads nothing", () => {
    const reset = vi.fn();
    render(<ErrorView error={new Error("boom")} reset={reset} />);
    expect(reloadOnce).not.toHaveBeenCalled();
    screen.getByTestId("error-view-retry").click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
