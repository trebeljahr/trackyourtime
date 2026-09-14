import { describe, expect, it } from "vitest";

import { authPageHref, safeNext, safeNextFromSearch } from "./safe-next";

describe("safeNext", () => {
  const accepted: [string, string][] = [
    ["/invite/?id=abc123", "/invite/?id=abc123"],
    ["/invite?id=abc123", "/invite?id=abc123"],
    ["/device/?user_code=ABCD-EFGH", "/device/?user_code=ABCD-EFGH"],
    ["/track", "/track"],
    ["/track/", "/track/"],
    ["/members/", "/members/"],
    ["/settings/?tab=workspace", "/settings/?tab=workspace"],
  ];

  it.each(accepted)("accepts %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  const rejected: [string, unknown][] = [
    ["protocol-relative host", "//evil.com"],
    ["protocol-relative host with a path", "//evil.com/invite"],
    ["backslash host", "/\\evil.com"],
    ["backslash anywhere", "/invite\\..\\..\\evil"],
    ["absolute https URL", "https://evil.com/invite"],
    ["absolute http URL", "http://evil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["tab smuggled between slashes", "/\t/evil.com"],
    ["newline smuggled between slashes", "/\n/evil.com"],
    ["leading space", " /track"],
    ["unlisted path", "/reports"],
    ["root", "/"],
    ["prefix look-alike", "/invitee"],
    ["prefix look-alike with query", "/tracker?x=1"],
    ["dot segments escaping the allowlist", "/track/../evil"],
    ["encoded slashes", "/%2F%2Fevil.com"],
    ["relative path", "track"],
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["overlong", `/track/${"a".repeat(3000)}`],
  ];

  it.each(rejected)("rejects %s", (_label, raw) => {
    expect(safeNext(raw)).toBeNull();
  });

  it("reads next from a query string", () => {
    expect(safeNextFromSearch("?next=%2Finvite%2F%3Fid%3Dx")).toBe("/invite/?id=x");
    expect(safeNextFromSearch("?next=%2F%2Fevil.com")).toBeNull();
    expect(safeNextFromSearch("")).toBeNull();
  });
});

describe("authPageHref", () => {
  it("carries a safe next and an email", () => {
    const href = authPageHref("signup", {
      next: "/invite/?id=x",
      email: "bob@example.com",
    });
    const url = new URL(href, "https://app.test");
    expect(url.pathname).toBe("/signup/");
    expect(url.searchParams.get("next")).toBe("/invite/?id=x");
    expect(url.searchParams.get("email")).toBe("bob@example.com");
  });

  it("drops an unsafe next instead of forwarding it", () => {
    expect(authPageHref("login", { next: "//evil.com" })).toBe("/login");
  });
});
