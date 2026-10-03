// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const fake = vi.hoisted(() => ({ ready: true, enabled: true, get: vi.fn() }));
vi.mock("@/hooks/use-api-origin", () => ({ useApiOrigin: () => ({ ready: fake.ready }) }));
vi.mock("@/lib/android-password-manager", () => ({
  canUseAndroidPasswords: () => fake.enabled,
  getAndroidPassword: fake.get,
}));
import { AndroidPasswordFill } from "./android-password-fill";
beforeEach(() => {
  fake.ready = true;
  fake.enabled = true;
  fake.get.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

it("fills both values only after the user opens the picker", async () => {
  const onFill = vi.fn();
  fake.get.mockResolvedValue({ email: "test@example.com", password: "fake-password" });
  render(<AndroidPasswordFill disabled={false} onFill={onFill} />);
  expect(fake.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(onFill).toHaveBeenCalledWith({ email: "test@example.com", password: "fake-password" }));
});
it.each(["hydrating", "unsupported"])("hides the picker while %s", (mode) => {
  fake.ready = mode !== "hydrating";
  fake.enabled = mode !== "unsupported";
  render(<AndroidPasswordFill disabled={false} onFill={vi.fn()} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("leaves fields alone when the picker is dismissed", async () => {
  const onFill = vi.fn();
  render(<AndroidPasswordFill disabled={false} onFill={onFill} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  expect(onFill).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("explains missing credentials without exposing provider error details", async () => {
  fake.get.mockRejectedValue({ code: "NO_CREDENTIAL", message: "private provider data" });
  render(<AndroidPasswordFill disabled={false} onFill={vi.fn()} />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("status")).toHaveTextContent("No saved password");
  expect(screen.getByRole("status")).not.toHaveTextContent("private provider data");
});
it("cancels on unmount and ignores a late result", async () => {
  let resolve!: (value: unknown) => void;
  fake.get.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const onFill = vi.fn();
  const { unmount } = render(<AndroidPasswordFill disabled={false} onFill={onFill} />);
  fireEvent.click(screen.getByRole("button"));
  const signal = fake.get.mock.calls[0][0] as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  resolve({ email: "test@example.com", password: "must-not-fill" });
  await Promise.resolve();
  expect(onFill).not.toHaveBeenCalled();
});
