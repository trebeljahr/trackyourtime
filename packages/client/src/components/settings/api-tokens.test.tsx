// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiTokenSummary } from "@starter/shared";

import { Dialog } from "@/components/ui/dialog";
import { apiTokenState, formatDay } from "./api-tokens";
import {
  ApiTokenForm,
  OneTimeSecret,
  endOfDayIso,
  needsStepUp,
  type ApiTokenFormValues,
} from "./create-api-token-dialog";

const token = (overrides: Partial<ApiTokenSummary> = {}): ApiTokenSummary => ({
  id: "t1",
  name: "Invoicing script",
  prefix: "AbCdEfGh",
  scopes: ["entries:read"],
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/**
 * Radix's checkbox measures itself with a `ResizeObserver`, which jsdom does
 * not implement — without this stub every render of a form containing one
 * throws before a single assertion runs.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ??
  (ResizeObserverStub as unknown as typeof ResizeObserver);

afterEach(() => {
  cleanup();
});

/**
 * Radix's `DialogTitle` reads its id off the dialog context, so a form built
 * for a dialog has to be rendered inside one — the root alone is enough, with
 * no portal to fight in jsdom.
 */
const renderForm = () => {
  const onCreate = vi.fn<(values: ApiTokenFormValues) => void>();
  render(
    <Dialog open onOpenChange={() => undefined}>
      <ApiTokenForm
        onCreate={onCreate}
        onCancel={() => undefined}
        isPending={false}
      />
    </Dialog>,
  );
  return { onCreate };
};

describe("needsStepUp", () => {
  it("is true only for the server's step-up refusal", () => {
    expect(needsStepUp({ message: "TWO_FACTOR_STEP_UP_REQUIRED", data: { code: "FORBIDDEN" } })).toBe(true);
    expect(needsStepUp({ message: "Forbidden" })).toBe(false);
    expect(needsStepUp(null)).toBe(false);
  });
});

describe("apiTokenState", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");

  it("reads a live token as active", () => {
    expect(apiTokenState(token(), now)).toBe("active");
  });

  it("reads a lapsed expiry as expired without anything having written to it", () => {
    expect(
      apiTokenState(token({ expiresAt: "2026-05-31T23:59:59.000Z" }), now),
    ).toBe("expired");
  });

  it("keeps an expiry in the future active", () => {
    expect(
      apiTokenState(token({ expiresAt: "2026-06-02T23:59:59.000Z" }), now),
    ).toBe("active");
  });

  it("lets revocation win over an expiry that has not passed", () => {
    // Revoked is the stronger statement: an unexpired token that was turned
    // off must never read as merely "active until December".
    expect(
      apiTokenState(
        token({
          expiresAt: "2026-12-31T23:59:59.000Z",
          revokedAt: "2026-05-02T10:00:00.000Z",
        }),
        now,
      ),
    ).toBe("revoked");
  });
});

describe("formatDay", () => {
  it("never renders an unparseable date as Invalid Date", () => {
    expect(formatDay("not a date")).toBe("Unknown");
  });
});

describe("endOfDayIso", () => {
  it("expires at the end of the chosen day, not as it begins", () => {
    const iso = endOfDayIso("2026-12-31");
    expect(iso).not.toBeNull();
    const parsed = new Date(iso ?? "");
    expect(parsed.getDate()).toBe(31);
    expect(parsed.getHours()).toBe(23);
  });

  it("returns null for a day it cannot parse", () => {
    expect(endOfDayIso("31-12-2026")).toBeNull();
  });
});

describe("OneTimeSecret", () => {
  it("renders the plaintext and says it will not be shown again", () => {
    render(
      <OneTimeSecret
        value="tt_AbCdEfGh_thisisthesecrethalf"
        label="Invoicing script"
        hint="Only a hash of it is stored."
        testId="api-token-reveal"
      />,
    );

    expect(screen.getByTestId("api-token-reveal-plaintext")).toHaveTextContent(
      "tt_AbCdEfGh_thisisthesecrethalf",
    );
    expect(screen.getByTestId("api-token-reveal-warning")).toHaveTextContent(
      /only time it is shown/i,
    );
    expect(screen.getByTestId("api-token-reveal-copy")).toBeInTheDocument();
  });
});

describe("ApiTokenForm", () => {
  it("refuses an empty name instead of minting an unnamed token", () => {
    const { onCreate } = renderForm();

    fireEvent.submit(screen.getByTestId("api-token-submit"));

    expect(screen.getByTestId("api-token-name-error")).toHaveTextContent(
      "Name is required",
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("refuses a name that is only whitespace", () => {
    const { onCreate } = renderForm();

    fireEvent.change(screen.getByTestId("api-token-name-input"), {
      target: { value: "   " },
    });
    fireEvent.submit(screen.getByTestId("api-token-submit"));

    expect(screen.getByTestId("api-token-name-error")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("says out loud that a token with nothing ticked can do nothing", () => {
    // A zero-scope token is legal and mints happily; silence here would ship a
    // credential that answers 403 to everything and looks broken.
    renderForm();

    expect(screen.getByTestId("api-token-no-scopes")).toHaveTextContent(
      /can do nothing/i,
    );

    fireEvent.click(screen.getByTestId("api-token-scope-entries:read"));

    expect(screen.queryByTestId("api-token-no-scopes")).toBeNull();
  });

  it("submits the trimmed name, the ticked scopes and no expiry", () => {
    const { onCreate } = renderForm();

    fireEvent.change(screen.getByTestId("api-token-name-input"), {
      target: { value: "  Invoicing script  " },
    });
    fireEvent.click(screen.getByTestId("api-token-scope-entries:read"));
    fireEvent.click(screen.getByTestId("api-token-scope-reports:read"));
    fireEvent.submit(screen.getByTestId("api-token-submit"));

    expect(onCreate).toHaveBeenCalledWith({
      name: "Invoicing script",
      scopes: ["entries:read", "reports:read"],
      expiresAt: null,
    });
  });

  it("refuses an expiry that has already passed", () => {
    const { onCreate } = renderForm();

    fireEvent.change(screen.getByTestId("api-token-name-input"), {
      target: { value: "Old token" },
    });
    fireEvent.change(screen.getByTestId("api-token-expiry-input"), {
      target: { value: "2020-01-01" },
    });
    fireEvent.submit(screen.getByTestId("api-token-submit"));

    expect(screen.getByTestId("api-token-expiry-error")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
