// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  WebhookDeliveryWire,
  WebhookSubscriptionWire,
} from "@starter/shared";

import { Dialog } from "@/components/ui/dialog";
import {
  DELIVERY_STATUS_LABELS,
  deliveryDetail,
  webhookHealth,
} from "./webhooks";
import {
  WebhookForm,
  webhookUrlError,
  type WebhookFormValues,
} from "./create-webhook-dialog";
import { OneTimeSecret } from "./create-api-token-dialog";

const subscription = (
  overrides: Partial<WebhookSubscriptionWire> = {},
): WebhookSubscriptionWire => ({
  id: "w1",
  url: "https://example.com/hooks/trackyourtime",
  events: ["entry.started"],
  enabled: true,
  consecutiveFailures: 0,
  disabledAt: null,
  lastDeliveryAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const delivery = (
  overrides: Partial<WebhookDeliveryWire> = {},
): WebhookDeliveryWire => ({
  id: "d1",
  subscriptionId: "w1",
  event: "entry.started",
  status: "delivered",
  attempt: 1,
  responseStatus: 200,
  error: null,
  nextAttemptAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
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

/** Same reason as the token form: `DialogTitle` needs the dialog context. */
const renderForm = () => {
  const onCreate = vi.fn<(values: WebhookFormValues) => void>();
  render(
    <Dialog open onOpenChange={() => undefined}>
      <WebhookForm
        onCreate={onCreate}
        onCancel={() => undefined}
        isPending={false}
      />
    </Dialog>,
  );
  return { onCreate };
};

describe("webhookUrlError", () => {
  it("refuses an empty or whitespace-only endpoint", () => {
    expect(webhookUrlError("")).toBe("Endpoint URL is required");
    expect(webhookUrlError("   ")).toBe("Endpoint URL is required");
  });

  it("refuses a host with no scheme, which is the usual typo", () => {
    expect(webhookUrlError("example.com/hooks")).not.toBeNull();
  });

  it("refuses a scheme nothing can POST to", () => {
    expect(webhookUrlError("ftp://example.com/hooks")).not.toBeNull();
  });

  it("accepts an https endpoint", () => {
    expect(webhookUrlError("https://example.com/hooks")).toBeNull();
  });

  it("leaves plain http to the server", () => {
    // Whether http is deliverable is a server setting, and the server resolves
    // the host anyway — refusing it here would break self-hosted local setups
    // for a rule this browser cannot actually enforce.
    expect(webhookUrlError("http://localhost:5159/hooks")).toBeNull();
  });
});

describe("webhookHealth", () => {
  it("says an endpoint is active when nothing has failed", () => {
    expect(webhookHealth(subscription()).label).toBe("Active");
  });

  it("separates a paused endpoint from one that turned itself off", () => {
    const paused = webhookHealth(subscription({ enabled: false }));
    expect(paused.label).toBe("Paused");
    expect(paused.detail).toBeNull();

    const broken = webhookHealth(
      subscription({
        enabled: false,
        consecutiveFailures: 15,
        disabledAt: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(broken.label).toBe("Turned off");
    // The count is the whole point: an endpoint that went quiet on its own is
    // the failure people find weeks later.
    expect(broken.detail).toContain("15");
  });

  it("flags an enabled endpoint that is still failing", () => {
    const failing = webhookHealth(subscription({ consecutiveFailures: 3 }));
    expect(failing.label).toBe("Failing");
    expect(failing.detail).toContain("3");
  });
});

describe("deliveryDetail", () => {
  it("explains a skipped delivery as a permission, not a failure", () => {
    expect(
      deliveryDetail(delivery({ status: "skipped_visibility", responseStatus: null })),
    ).toMatch(/cannot see/i);
    expect(DELIVERY_STATUS_LABELS.skipped_visibility.label).toBe("Not sent");
  });

  it("prefers the error over the response code", () => {
    expect(
      deliveryDetail(
        delivery({
          status: "failed",
          error: "redirect_not_followed",
          responseStatus: 302,
        }),
      ),
    ).toBe("redirect_not_followed");
  });

  it("falls back to the response code", () => {
    expect(deliveryDetail(delivery())).toBe("HTTP 200");
  });

  it("tells a queued delivery when it will be retried", () => {
    const detail = deliveryDetail(
      delivery({
        status: "pending",
        responseStatus: null,
        nextAttemptAt: "2026-01-01T00:10:00.000Z",
      }),
    );
    expect(detail).toMatch(/^Next try /);
  });
});

describe("OneTimeSecret, as the webhook uses it", () => {
  it("renders the signing secret once, with the warning attached", () => {
    render(
      <OneTimeSecret
        value="a-signing-secret"
        label="Signing secret"
        hint="The server never reads it back out."
        testId="webhook-reveal"
      />,
    );

    expect(screen.getByTestId("webhook-reveal-plaintext")).toHaveTextContent(
      "a-signing-secret",
    );
    expect(screen.getByTestId("webhook-reveal-warning")).toHaveTextContent(
      /only time it is shown/i,
    );
  });
});

describe("WebhookForm", () => {
  it("refuses an empty endpoint", () => {
    const { onCreate } = renderForm();

    fireEvent.click(screen.getByTestId("webhook-event-entry.started"));
    fireEvent.submit(screen.getByTestId("webhook-submit"));

    expect(screen.getByTestId("webhook-url-error")).toHaveTextContent(
      "Endpoint URL is required",
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("refuses a subscription with no events, which would exist to do nothing", () => {
    const { onCreate } = renderForm();

    fireEvent.change(screen.getByTestId("webhook-url-input"), {
      target: { value: "https://example.com/hooks" },
    });
    fireEvent.submit(screen.getByTestId("webhook-submit"));

    expect(screen.getByTestId("webhook-events-error")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("submits the trimmed URL and the ticked events", () => {
    const { onCreate } = renderForm();

    fireEvent.change(screen.getByTestId("webhook-url-input"), {
      target: { value: "  https://example.com/hooks  " },
    });
    fireEvent.click(screen.getByTestId("webhook-event-entry.started"));
    fireEvent.click(screen.getByTestId("webhook-event-entry.stopped"));
    fireEvent.submit(screen.getByTestId("webhook-submit"));

    expect(onCreate).toHaveBeenCalledWith({
      url: "https://example.com/hooks",
      events: ["entry.started", "entry.stopped"],
    });
  });
});
