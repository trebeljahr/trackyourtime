import { describe, expect, test } from "vitest";
import { loadSession, saveSession, SESSION_STORAGE_KEY } from "./session";

describe("the stored session", () => {
  test("keeps its source", async () => {
    await saveSession({ token: "t", userId: "u", email: null, source: "web" });
    expect(await loadSession()).toEqual({ token: "t", userId: "u", email: null, source: "web" });
  });

  test("reads a record from before the source existed as a password session", async () => {
    await chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: JSON.stringify({ token: "t", userId: "u", email: "a@example.com" }),
    });
    expect((await loadSession())?.source).toBe("password");
  });

  test("reads an unknown source as a password session, never as a web one", async () => {
    await chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: JSON.stringify({ token: "t", userId: null, email: null, source: "cookie" }),
    });
    expect((await loadSession())?.source).toBe("password");
  });

  test("a malformed record is no session", async () => {
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: "{not json" });
    expect(await loadSession()).toBeNull();
  });
});
