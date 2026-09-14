import { describe, expect, it } from "vitest";

import { getTranslator } from "@/i18n/translator";
import { userErrorMessage } from "@/lib/error-message";

const serverError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { data: { code } });

describe("userErrorMessage", () => {
  it("replaces the browser's transport text with the localised network message", () => {
    const de = getTranslator("de", "common");
    expect(userErrorMessage(new TypeError("Failed to fetch"), "Fallback", de)).toBe(
      de("errors.network"),
    );
    expect(userErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Could not reach the server. Check your connection and try again.",
    );
  });

  it("keeps a specific server message", () => {
    expect(userErrorMessage(serverError("NOT_FOUND", "Task not found"), "Fallback")).toBe(
      "Task not found",
    );
  });

  it("uses the fallback for an internal server error", () => {
    expect(
      userErrorMessage(serverError("INTERNAL_SERVER_ERROR", "Internal server error"), "Fallback"),
    ).toBe("Fallback");
  });

  it("uses the fallback, else the generic message, when there is no message", () => {
    expect(userErrorMessage(new Error(""), "Fallback")).toBe("Fallback");
    expect(userErrorMessage(null, undefined, getTranslator("de", "common"))).toBe(
      getTranslator("de", "common")("errors.generic"),
    );
  });
});
