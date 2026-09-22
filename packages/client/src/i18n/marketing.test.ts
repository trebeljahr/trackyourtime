import { describe, expect, it } from "vitest";

import { localizedPath, marketingMetadata } from "@/i18n/marketing";

describe("localizedPath", () => {
  it("leaves English unprefixed and prefixes German", () => {
    expect(localizedPath("en", "/privacy/")).toBe("/privacy/");
    expect(localizedPath("de", "/privacy/")).toBe("/de/privacy/");
    expect(localizedPath("de", "/")).toBe("/de/");
  });

  it("maps a page whose German slug differs from the English one", () => {
    expect(localizedPath("en", "/invoice-generator/")).toBe("/invoice-generator/");
    expect(localizedPath("de", "/invoice-generator/")).toBe("/de/rechnung-erstellen/");
  });
});

describe("marketingMetadata", () => {
  it("declares the page's own canonical and every alternate", () => {
    const meta = marketingMetadata("de", { title: "Datenschutz", description: "…", path: "/privacy/" });
    expect(meta.alternates?.canonical).toBe("/de/privacy/");
    expect(meta.alternates?.languages).toEqual({
      "x-default": "/privacy/",
      en: "/privacy/",
      de: "/de/privacy/",
    });
    expect(meta.openGraph).toMatchObject({ locale: "de_DE", url: "/de/privacy/" });
  });
});
