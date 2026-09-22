// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let shell = false;
let reloadAllowed = true;
const reloadOnce = vi.fn(() => reloadAllowed);
const report = vi.fn();

vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => (shell ? "electron" : "web")),
);
vi.mock("@/lib/chunk-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chunk-reload")>()),
  reloadOnceForChunkError: () => reloadOnce(),
}));
vi.mock("@/lib/error-reporting/reporter", () => ({
  reportClientError: (...args: unknown[]) => report(...args),
}));

const { ErrorView } = await import("./error-view");

const chunkError = (): Error => {
  const error = new Error("Loading chunk 12 failed.");
  error.name = "ChunkLoadError";
  return error;
};

beforeEach(() => {
  shell = false;
  reloadAllowed = true;
  reloadOnce.mockClear();
  report.mockClear();
});
afterEach(cleanup);

describe("ErrorView", () => {
  it("reloads once on a chunk error on the web, and still offers Reload", () => {
    render(<ErrorView error={chunkError()} reset={() => undefined} boundary="app" />);
    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("error-view-reload")).toBeInTheDocument();
    expect(screen.queryByTestId("error-view-retry")).toBeNull();
  });

  it("never reloads by itself inside a shell", () => {
    shell = true;
    render(<ErrorView error={chunkError()} reset={() => undefined} boundary="app" />);
    expect(reloadOnce).not.toHaveBeenCalled();
  });

  it("offers Try again for any other error and reloads nothing", () => {
    const reset = vi.fn();
    render(<ErrorView error={new Error("boom")} reset={reset} boundary="app" />);
    expect(reloadOnce).not.toHaveBeenCalled();
    screen.getByTestId("error-view-retry").click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("ErrorView reporting", () => {
  it("reports any other error with the boundary it came from", () => {
    const error = new Error("boom");
    render(<ErrorView error={error} reset={() => undefined} boundary="global" />);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error, { source: "global" });
  });

  it("does not report a web chunk error the reload is about to fix", () => {
    render(<ErrorView error={chunkError()} reset={() => undefined} boundary="app" />);
    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports a web chunk error the guard refused to reload again, tagged as refused", () => {
    reloadAllowed = false;
    const error = chunkError();
    render(<ErrorView error={error} reset={() => undefined} boundary="app" />);
    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error, { source: "app", chunkReload: "refused" });
  });

  it("reports a chunk error in a shell, where a missing chunk is a real bug", () => {
    shell = true;
    const error = chunkError();
    render(<ErrorView error={error} reset={() => undefined} boundary="app" />);
    expect(report).toHaveBeenCalledWith(error, { source: "app" });
  });
});
