// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const shell = vi.hoisted(() => ({ native: false }));
vi.mock("@/lib/shell", () => ({ isTokenShell: () => shell.native }));
import { webCallbackUrl } from "./auth-callback";
afterEach(() => {
  shell.native = false;
});
it("uses the web origin for browser callbacks", () => {
  expect(webCallbackUrl("/login")).toBe(`${window.location.origin}/login`);
});
it("leaves native callbacks for the selected server to resolve", () => {
  shell.native = true;
  expect(webCallbackUrl("/login/?next=%2Fapp%2Ftrack%2F")).toBe(
    "/login/?next=%2Fapp%2Ftrack%2F",
  );
  expect(webCallbackUrl("/reset-password")).toBe("/reset-password");
});
