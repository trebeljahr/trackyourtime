// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Invoice } from "@starter/shared";
import { InvoiceFollowThrough } from "./invoice-follow-through";

const api = vi.hoisted(() => ({
  pay: vi.fn(),
  credit: vi.fn(),
  reminders: vi.fn(),
  preview: vi.fn(),
  invalidate: vi.fn(),
  pdf: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      invoices: {
        invalidate: api.invalidate,
        reminderPreview: { fetch: api.preview },
        exportCreditPdf: { fetch: api.pdf },
      },
    }),
    invoices: {
      recordPayment: { useMutation: () => ({ mutateAsync: api.pay }) },
      credit: { useMutation: () => ({ mutateAsync: api.credit }) },
      setReminders: { useMutation: () => ({ mutateAsync: api.reminders }) },
    },
  },
}));
vi.mock("@/hooks/use-sync", () => ({ ORIGIN_ID: "test" }));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/download", () => ({ downloadBase64: vi.fn() }));
const invoice: Invoice = {
  id: "invoice",
  workspaceId: "workspace",
  createdBy: "owner",
  number: "2026-001",
  clientId: "client",
  clientName: "Synthetic client",
  status: "sent",
  issueDate: "2026-09-01",
  dueDate: "2026-09-15",
  from: null,
  to: null,
  groupBy: "project",
  lineItems: [],
  subtotal: 100,
  taxRate: null,
  taxAmount: 0,
  total: 100,
  currency: "EUR",
  entryIds: [],
  notes: null,
  createdAt: "2026-09-01",
  updatedAt: "2026-09-01",
  balance: {
    available: true,
    totalMinor: 10000,
    paidMinor: 0,
    outstandingMinor: 10000,
    refundDueMinor: 0,
    overdueDays: 2,
    legacySettled: false,
  },
};
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.invalidate.mockResolvedValue(undefined);
});

describe("invoice follow-through controls", () => {
  it("shows historical JPY fractions without rounding away outstanding money", () => {
    render(
      <InvoiceFollowThrough
        invoice={{
          ...invoice,
          currency: "JPY",
          total: 12.5,
          balance: {
            available: true,
            totalMinor: 1250,
            paidMinor: 1200,
            outstandingMinor: 50,
            refundDueMinor: 0,
            overdueDays: 2,
            legacySettled: false,
          },
        }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("invoice-follow-through")).toHaveTextContent(
      /(?:¥|JPY)\s*0\.50/,
    );
  });
  it("shows an unavailable balance and offers no accounting or reminder actions", () => {
    render(
      <InvoiceFollowThrough
        invoice={{
          ...invoice,
          total: 1e20,
          balance: {
            available: false,
            totalMinor: null,
            paidMinor: null,
            outstandingMinor: null,
            refundDueMinor: null,
            overdueDays: 0,
            legacySettled: false,
          },
        }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("invoice-balance-unavailable")).toHaveTextContent(
      "cannot be calculated safely",
    );
    expect(
      screen.queryByTestId("invoice-record-payment"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Issue full credit" }),
    ).not.toBeInTheDocument();
  });
  it("reuses the payment request id when retrying a lost response", async () => {
    api.pay
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(invoice);
    render(<InvoiceFollowThrough invoice={invoice} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId("invoice-payment-amount"), {
      target: { value: "29.00" },
    });
    fireEvent.click(screen.getByTestId("invoice-record-payment"));
    await waitFor(() =>
      expect(screen.getByTestId("invoice-record-payment")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("invoice-record-payment"));
    await waitFor(() => expect(api.pay).toHaveBeenCalledTimes(2));
    expect(api.pay.mock.calls[0]?.[0].requestId).toBe(
      api.pay.mock.calls[1]?.[0].requestId,
    );
  });
  it("requires correction reason and explicit confirmation before full credit", async () => {
    api.credit.mockResolvedValue(invoice);
    render(<InvoiceFollowThrough invoice={invoice} onSelect={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Issue full credit" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Correction reason"), {
      target: { value: "Incorrect scope" },
    });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/This issues a full credit/));
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "Incorrect scope",
          replacement: false,
        }),
      ),
    );
  });
  it("defaults reminders off and requires a preview after editing recipient", async () => {
    api.preview.mockResolvedValue({
      to: "fake@example.test",
      subject: "Preview",
      text: "Payment details",
    });
    render(<InvoiceFollowThrough invoice={invoice} onSelect={vi.fn()} />);
    const consent = screen.getByLabelText(
      "Enable reminders for this recipient",
    );
    expect(consent).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Reminder recipient"), {
      target: { value: "fake@example.test" },
    });
    fireEvent.click(consent);
    expect(
      screen.getByRole("button", { name: "Save reminder settings" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview reminder" }));
    await screen.findByTestId("invoice-reminder-preview");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save reminder settings" }),
      ).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText("Reminder recipient"), {
      target: { value: "changed@example.test" },
    });
    expect(
      screen.queryByTestId("invoice-reminder-preview"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save reminder settings" }),
    ).toBeDisabled();
    expect(api.reminders).not.toHaveBeenCalled();
  });
});
