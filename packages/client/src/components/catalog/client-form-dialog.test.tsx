// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_CLIENT_BILLING, type Client } from "@starter/shared";

/**
 * The client dialog's billing section: the e-invoice fields it sends, what it
 * refuses to send, and the landing of a deep link from an invoice issue.
 */

const updateClient = vi.fn();
const createClient = vi.fn();

vi.mock("./use-catalog-mutations", () => ({
  useClientMutations: () => ({ updateClient, createClient, isSaving: false }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ClientFormDialog, billingDraftFrom, billingDraftValid, billingInputFromDraft } =
  await import("./client-form-dialog");

const client = (billing: Client["billing"]): Client => ({
  id: "c1",
  workspaceId: "ws",
  createdBy: "u",
  name: "Kunde AG",
  color: "#111111",
  archived: false,
  billing,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  updateClient.mockReset();
  updateClient.mockResolvedValue(null);
  createClient.mockReset();
});
afterEach(cleanup);

describe("billing draft", () => {
  it("sends every key, the VAT ID compact and a blank electronic address as a null pair", () => {
    const draft = {
      ...billingDraftFrom(client({ ...EMPTY_CLIENT_BILLING, city: "Wien", country: "AT" })),
      vatId: "atu 12345678",
    };
    expect(billingDraftValid(draft)).toBe(true);
    expect(billingInputFromDraft(draft)).toMatchObject({
      city: "Wien",
      country: "AT",
      vatId: "ATU12345678",
      electronicAddress: null,
      electronicAddressScheme: null,
      preferredFormat: null,
      defaultTaxCategory: null,
    });
  });

  it("is invalid with a malformed VAT ID or an address that does not fit its type", () => {
    const base = billingDraftFrom(null);
    expect(billingDraftValid({ ...base, vatId: "12345" })).toBe(false);
    expect(
      billingDraftValid({ ...base, electronicAddress: "x", electronicAddressScheme: "0088" }),
    ).toBe(false);
  });
});

describe("ClientFormDialog billing", () => {
  it("saves the new e-invoice fields with the edit", async () => {
    render(
      <ClientFormDialog
        open
        onOpenChange={() => {}}
        client={client({ ...EMPTY_CLIENT_BILLING, country: "AT", vatId: "ATU12345678" })}
        issuerCountry="DE"
      />,
    );
    fireEvent.change(screen.getByTestId("client-billing-reference"), {
      target: { value: "991-12345-06" },
    });
    fireEvent.change(screen.getByTestId("client-billing-preferredFormat"), {
      target: { value: "xrechnung" },
    });
    // AT buyer with a VAT ID from a DE seller: reverse charge is suggested, not set.
    fireEvent.click(screen.getByTestId("client-billing-tax-suggestion-use"));
    fireEvent.click(screen.getByTestId("client-submit"));

    expect(updateClient).toHaveBeenCalledTimes(1);
    expect(updateClient.mock.calls[0]?.[0]).toMatchObject({
      id: "c1",
      billing: {
        reference: "991-12345-06",
        vatId: "ATU12345678",
        preferredFormat: "xrechnung",
        defaultTaxCategory: "AE",
      },
    });
  });

  it("does not save a malformed VAT ID and says why", () => {
    render(<ClientFormDialog open onOpenChange={() => {}} client={client(null)} />);
    fireEvent.click(screen.getByTestId("client-billing-toggle"));
    fireEvent.change(screen.getByTestId("client-billing-vatId"), { target: { value: "12345" } });
    expect(screen.getByTestId("client-billing-vatId-error")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("client-submit"));
    expect(updateClient).not.toHaveBeenCalled();
  });

  it("moves a legacy tax ID into the VAT ID", () => {
    render(
      <ClientFormDialog
        open
        onOpenChange={() => {}}
        client={client({ ...EMPTY_CLIENT_BILLING, taxId: "ATU12345678" })}
      />,
    );
    fireEvent.click(screen.getByTestId("client-billing-taxid-use-vat"));
    expect(screen.getByTestId("client-billing-vatId")).toHaveValue("ATU12345678");
    expect(screen.queryByTestId("client-billing-legacy-taxid")).not.toBeInTheDocument();
  });

  it("keeps the legacy tax ID input while its text is cleared to be retyped", () => {
    render(
      <ClientFormDialog
        open
        onOpenChange={() => {}}
        client={client({ ...EMPTY_CLIENT_BILLING, taxId: "ATU12345678" })}
      />,
    );
    fireEvent.change(screen.getByTestId("client-billing-taxId"), { target: { value: "" } });
    expect(screen.getByTestId("client-billing-taxId")).toHaveValue("");
  });

  it("lands a deep link on the billing input, expanded, with a way back", () => {
    render(
      <ClientFormDialog
        open
        onOpenChange={() => {}}
        client={client(null)}
        focusBillingField="reference"
        fromInvoiceId="inv1"
      />,
    );
    const input = screen.getByTestId("client-billing-reference");
    expect(input).toHaveFocus();
    expect(input.closest("[data-field]")).toHaveAttribute("data-highlight", "true");
    expect(screen.getByTestId("client-billing-back-to-invoice")).toHaveAttribute(
      "href",
      "/invoices?invoice=inv1",
    );
  });
});
