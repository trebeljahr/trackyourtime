// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Invoice } from "@starter/shared";

import type { MockShell } from "@/lib/shell-mock";
import { DONATION_SUPPORTED_AT_KEY } from "@/lib/donation-return";
import { DONATE_URL } from "@/lib/site-links";
import { InvoiceDetail } from "./invoice-detail";
import { claimInvoiceSupportCard, INVOICE_SUPPORT_CARD_KEY } from "./invoice-support-card";

const api = vi.hoisted(() => ({
  shell: "web" as MockShell,
  downloadPdf: vi.fn(),
}));

vi.mock("@/lib/shell", async () => {
  const { mockShellModule } = await import("@/lib/shell-mock");
  return mockShellModule(() => api.shell);
});
vi.mock("./use-invoices", () => ({
  useInvoiceMutations: () => ({
    setStatus: vi.fn(),
    removeInvoice: vi.fn(),
    downloadPdf: api.downloadPdf,
    isBusy: false,
  }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/components/workspace-switcher", () => ({
  useActiveWorkspace: () => ({ activeId: "workspace" }),
}));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => false }));
vi.mock("./einvoice-panel", () => ({ EinvoicePanel: () => null }));

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
};

const renderDetail = (): void => {
  render(<InvoiceDetail invoice={invoice} onClose={() => {}} onDeleted={() => {}} onSelect={() => {}} />);
};

const download = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId("invoice-download-pdf"));
  await waitFor(() => expect(screen.getByTestId("invoice-download-pdf")).toBeEnabled());
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.shell = "web";
  api.downloadPdf.mockResolvedValue(true);
  window.localStorage.clear();
});

describe("claimInvoiceSupportCard", () => {
  it("answers yes once per browser and remembers it", () => {
    expect(claimInvoiceSupportCard()).toBe(true);
    expect(window.localStorage.getItem(INVOICE_SUPPORT_CARD_KEY)).toBe("shown");
    expect(claimInvoiceSupportCard()).toBe(false);
  });

  it.each(["capacitor", "electron"] as const)("never answers yes in the %s shell", (shell) => {
    api.shell = shell;
    expect(claimInvoiceSupportCard()).toBe(false);
    expect(window.localStorage.getItem(INVOICE_SUPPORT_CARD_KEY)).toBeNull();
  });

  it("stays hidden for someone who already donated, for good", () => {
    window.localStorage.setItem(DONATION_SUPPORTED_AT_KEY, "1760000000000");
    expect(claimInvoiceSupportCard()).toBe(false);
    window.localStorage.removeItem(DONATION_SUPPORTED_AT_KEY);
    expect(claimInvoiceSupportCard()).toBe(false);
  });

  it("shows nothing when storage cannot remember it", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(claimInvoiceSupportCard(broken)).toBe(false);
    expect(claimInvoiceSupportCard(null)).toBe(false);
  });
});

describe("support card on the invoice detail", () => {
  it("appears inline after the first PDF download and closes for good", async () => {
    renderDetail();
    expect(screen.queryByTestId("invoice-support-card")).not.toBeInTheDocument();

    await download();
    const card = await screen.findByTestId("invoice-support-card");
    expect(card.tagName).toBe("ASIDE");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("invoice-support-card-donate")).toHaveAttribute("href", DONATE_URL);
    expect(card).toHaveTextContent("Track Your Time has no paid plan.");

    fireEvent.click(screen.getByTestId("invoice-support-card-close"));
    expect(screen.queryByTestId("invoice-support-card")).not.toBeInTheDocument();

    await download();
    expect(api.downloadPdf).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("invoice-support-card")).not.toBeInTheDocument();
  });

  it("does not show again on a later visit, closed or not", async () => {
    renderDetail();
    await download();
    expect(await screen.findByTestId("invoice-support-card")).toBeInTheDocument();
    cleanup();

    renderDetail();
    await download();
    expect(screen.queryByTestId("invoice-support-card")).not.toBeInTheDocument();
  });

  it("waits for a download that worked", async () => {
    api.downloadPdf.mockResolvedValue(false);
    renderDetail();
    await download();
    expect(screen.queryByTestId("invoice-support-card")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INVOICE_SUPPORT_CARD_KEY)).toBeNull();
  });

  it.each(["capacitor", "electron"] as const)("never appears in the %s shell", async (shell) => {
    api.shell = shell;
    renderDetail();
    await download();
    expect(api.downloadPdf).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("invoice-support-card")).not.toBeInTheDocument();
  });
});
