// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { DONATION_SUPPORTED_AT_KEY, recordDonationReturn } from "./donation-return";

const NOW = 1_790_000_000_000;

const at = (path: string): void => {
  window.history.replaceState(null, "", path);
};

const address = (): string => `${window.location.pathname}${window.location.search}${window.location.hash}`;

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  at("/");
});

describe("recordDonationReturn", () => {
  it("stores the arrival time and removes the parameter", () => {
    at("/?supported=1");
    expect(recordDonationReturn(window, NOW)).toBe(true);
    expect(window.localStorage.getItem(DONATION_SUPPORTED_AT_KEY)).toBe(String(NOW));
    expect(address()).toBe("/");
  });

  it("keeps every other parameter, their encoding and the hash", () => {
    at("/de/?a=b%20c&supported=1&utm_source=x+y#faq");
    expect(recordDonationReturn(window, NOW)).toBe(true);
    expect(address()).toBe("/de/?a=b%20c&utm_source=x+y#faq");
  });

  it("keeps the hash when the parameter was the only one", () => {
    at("/?supported=1#free");
    recordDonationReturn(window, NOW);
    expect(address()).toBe("/#free");
  });

  it("does nothing without the parameter, or with another value", () => {
    const replace = vi.spyOn(window.history, "replaceState");
    for (const path of ["/", "/?supported=0", "/?supported=12", "/?notsupported=1", "/#supported=1"]) {
      at(path);
      replace.mockClear();
      expect(recordDonationReturn(window, NOW)).toBe(false);
      expect(replace).not.toHaveBeenCalled();
      expect(address()).toBe(path);
    }
    expect(window.localStorage.getItem(DONATION_SUPPORTED_AT_KEY)).toBeNull();
  });

  it("still cleans the address when storage refuses", () => {
    at("/?supported=1&x=1");
    const win = {
      location: window.location,
      history: window.history,
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    expect(recordDonationReturn(win, NOW)).toBe(true);
    expect(address()).toBe("/?x=1");
  });

  it("still cleans the address when a write throws", () => {
    at("/?supported=1");
    const win = {
      location: window.location,
      history: window.history,
      localStorage: {
        setItem: (): void => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        },
      },
    };
    expect(recordDonationReturn(win, NOW)).toBe(true);
    expect(address()).toBe("/");
  });

  it("passes null as the history state, so Next's router syncs its URL", () => {
    at("/?supported=1");
    const replace = vi.spyOn(window.history, "replaceState");
    recordDonationReturn(window, NOW);
    expect(replace).toHaveBeenCalledWith(null, "", "/");
  });
});
