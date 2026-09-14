import { TWO_FACTOR_UNSUPPORTED } from "@starter/core";
import { describe, expect, test } from "vitest";
import { extensionT } from "../i18n";
import { describeError } from "./errors";

const API_URL = "https://api.trackyourtime.dev";

// Core's English sentence, which the popup must never show in place of its own.
const CORE_MESSAGE =
  "This account uses two-factor authentication, which this client does not support yet. Sign in on the web app.";

describe("describeError", () => {
  test("a two-factor challenge sends the reader to the web app, in English", () => {
    const text = describeError(TWO_FACTOR_UNSUPPORTED, CORE_MESSAGE, API_URL, extensionT("en", "popup"));
    expect(text).not.toBe(CORE_MESSAGE);
    expect(text).toContain("web app in this browser");
  });

  test("a two-factor challenge is translated, not core's English fallback", () => {
    const text = describeError(TWO_FACTOR_UNSUPPORTED, CORE_MESSAGE, API_URL, extensionT("de", "popup"));
    expect(text).toContain("Zwei-Faktor-Authentifizierung");
    expect(text).toContain("Web-App");
    expect(text).not.toContain("two-factor");
  });
});
