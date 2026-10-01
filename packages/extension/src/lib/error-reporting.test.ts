import { describe, expect, it, vi } from "vitest";
import { makeEnvelope, reportExtensionError, safeErrorName } from "./error-reporting";

describe("extension error reporting", () => {
  it("keeps only known error names", () => {
    expect(safeErrorName(new TypeError("secret"))).toBe("TypeError");
    expect(safeErrorName(Object.assign(new Error("secret"), { name: "user@example.com" }))).toBe("Error");
  });

  it("never includes sensitive error content", () => {
    const error = new TypeError("Bearer secret https://host/path?token=abc user@example.com");
    error.stack = "https://host/path?token=abc";
    const envelope = makeEnvelope(error, "popup", "id", "2026-10-01T00:00:00Z");
    expect(envelope).toContain("TypeError");
    expect(envelope).toContain('"source":"popup"');
    for (const secret of ["secret", "token", "user@example.com", "https://host"]) expect(envelope).not.toContain(secret);
  });

  it("sends nothing when no DSN was built in", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    reportExtensionError(new Error("secret"), "background");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
