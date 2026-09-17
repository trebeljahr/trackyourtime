import { TWO_FACTOR_UNSUPPORTED } from "@starter/core";
import { describe, expect, test } from "vitest";
import { extensionT } from "../i18n";
import { describeDeviceSignInError, describeError } from "./errors";

const API_URL = "https://api.trackyourtime.dev";

// Core's English sentence, which the popup must never show in place of its own.
const CORE_MESSAGE =
  "This account uses two-factor authentication, which this client does not support yet. Sign in on the web app.";

describe("describeError", () => {
  test("a two-factor challenge points at Sign in with the web app, in English", () => {
    const text = describeError(TWO_FACTOR_UNSUPPORTED, CORE_MESSAGE, API_URL, extensionT("en", "popup"));
    expect(text).not.toBe(CORE_MESSAGE);
    expect(text).toContain("Sign in with the web app");
  });

  test("a two-factor challenge is translated, not core's English fallback", () => {
    const text = describeError(TWO_FACTOR_UNSUPPORTED, CORE_MESSAGE, API_URL, extensionT("de", "popup"));
    expect(text).toContain("Zwei-Faktor-Authentifizierung");
    expect(text).toContain("Mit der Web-App anmelden");
    expect(text).not.toContain("two-factor");
  });

  test("an untrusted origin names the settings and this extension's origin", () => {
    const text = describeError("ORIGIN_NOT_TRUSTED", "", "https://track.example.com", extensionT("en", "popup"));
    expect(text).toContain("track.example.com");
    expect(text).toContain("TRUST_STORE_APPS=true");
    expect(text).toContain(`chrome-extension://${chrome.runtime.id}`);
  });

  test("the removed Chrome access codes are gone from the catalog", () => {
    const t = extensionT("en", "popup");
    expect(describeError("SERVER_ACCESS_MISSING", "raw", API_URL, t)).toBe("raw");
  });
});

describe("describeDeviceSignInError", () => {
  test("says each ending in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      const t = extensionT(locale, "popup");
      const texts = (["denied", "expired", "failed"] as const).map((e) => describeDeviceSignInError(e, t));
      expect(new Set(texts).size).toBe(3);
    }
  });
});
