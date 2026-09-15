// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EMPTY_CLIENT_BILLING,
  emptyBusinessProfile,
  type EinvoiceCheckResult,
  type EinvoiceFillPreview,
  type EinvoiceIssue,
} from "@starter/shared";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EinvoiceFillBody, type EinvoiceFillBodyProps } from "./einvoice-fill-dialog";
import { EinvoiceIssues } from "./einvoice-issues";
import { EinvoicePanelBody } from "./einvoice-panel";
import { einvoiceFillRefusalFromError, einvoiceIssuesFromError } from "./use-einvoice";

/** Radix's checkbox measures itself; jsdom has no ResizeObserver. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(cleanup);

const issue = (overrides: Partial<EinvoiceIssue>): EinvoiceIssue => ({
  code: "SELLER_POSTCODE_MISSING",
  field: "businessProfile.postalCode",
  message: "Postal code is missing. Add it in Settings.",
  fixIn: "businessProfile",
  rule: "BR-DE-4",
  ...overrides,
});

const check = (overrides: Partial<EinvoiceCheckResult>): EinvoiceCheckResult => ({
  ready: false,
  issues: [],
  fill: null,
  issuesAfterFill: [],
  preferredFormat: null,
  hasIssuedXml: false,
  fillLocked: false,
  ...overrides,
});

const INVOICE = {
  id: "inv1",
  number: "RE-2026-0007",
  status: "sent" as const,
  clientId: "c1",
  clientName: "Kunde AG",
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-09-15T00:00:00.000Z",
  subtotal: 1000,
  taxAmount: 190,
  total: 1190,
  currency: "EUR",
};

describe("EinvoiceIssues", () => {
  it("links a profile issue to settings and gives a totals mismatch no link", () => {
    render(
      <EinvoiceIssues
        issues={[
          issue({}),
          issue({ code: "TOTALS_MISMATCH", fixIn: "invoice", field: "invoice.total", rule: "BR-CO-15" }),
        ]}
        invoiceId="inv1"
        clientName="Kunde AG"
        isDraft={false}
        testIdPrefix="einvoice-issues"
      />,
    );
    const links = screen.getAllByTestId("einvoice-fix-link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/app/settings?tab=billing&field=postalCode&from=invoice:inv1");
    const items = screen.getAllByTestId("einvoice-issues-item");
    expect(items[1]).toHaveAttribute("data-code", "TOTALS_MISMATCH");
  });

  it("uses the catalog text for a known code and the server message otherwise", () => {
    render(
      <EinvoiceIssues
        issues={[issue({}), issue({ code: "SOMETHING_NEW" as EinvoiceIssue["code"], message: "A newer rule." })]}
        invoiceId="inv1"
        clientName="Kunde AG"
        isDraft
        testIdPrefix="einvoice-issues"
      />,
    );
    const items = screen.getAllByTestId("einvoice-issues-item");
    expect(items[0]).toHaveTextContent("Your postal code is missing.");
    expect(items[1]).toHaveTextContent("A newer rule.");
  });
});

describe("EinvoiceIssues precision", () => {
  it("keeps the server's sentence when it names the line", () => {
    render(
      <EinvoiceIssues
        issues={[
          issue({
            code: "LINE_TAX_RATE_INVALID",
            fixIn: "invoice",
            field: "invoice.lineItems[1].taxRate",
            message: 'Line 2 ("Design") has category S at 0 %.',
            rule: "BR-S-05",
          }),
        ]}
        invoiceId="inv1"
        clientName="Kunde AG"
        isDraft={false}
        testIdPrefix="einvoice-issues"
      />,
    );
    expect(screen.getByTestId("einvoice-issues-item")).toHaveTextContent('Line 2 ("Design")');
  });
});

describe("EinvoicePanelBody", () => {
  const renderBody = (value: EinvoiceCheckResult, refusal: EinvoiceIssue[] | null = null): void => {
    render(
      <EinvoicePanelBody
        invoice={{ ...INVOICE, issuer: undefined, recipient: undefined, taxBreakdown: undefined }}
        check={value}
        refusal={refusal}
        onFill={() => {}}
        onDownloadPdf={() => {}}
      />,
    );
  };

  it("renders each state", () => {
    renderBody(check({ ready: true }));
    expect(screen.getByTestId("einvoice-ready")).toBeInTheDocument();
    cleanup();
    renderBody(check({ ready: true, hasIssuedXml: true }));
    expect(screen.getByTestId("einvoice-issued")).toBeInTheDocument();
    cleanup();
    renderBody(check({ fill: { fields: ["issuer"], lineTax: "none", fixedTax: null, mismatch: null } }));
    expect(screen.getByTestId("einvoice-fill-callout")).toBeInTheDocument();
    cleanup();
    renderBody(check({ issues: [issue({})] }), [issue({ code: "BUYER_REFERENCE_MISSING", fixIn: "clientBilling", field: "clientBilling.reference", clientId: "c1" })]);
    expect(screen.getByTestId("einvoice-refusal")).toBeInTheDocument();
    expect(screen.queryByTestId("einvoice-issues")).not.toBeInTheDocument();
    expect(screen.getByTestId("einvoice-refusal-item")).toHaveAttribute("data-code", "BUYER_REFERENCE_MISSING");
  });
});

describe("EinvoicePanelBody after an issue in the other format", () => {
  it("says the details are final and offers no fix link", () => {
    render(
      <EinvoicePanelBody
        invoice={{ ...INVOICE, issuer: undefined, recipient: undefined, taxBreakdown: undefined }}
        check={check({
          issues: [issue({ code: "SELLER_IBAN_MISSING", field: "businessProfile.iban" })],
          fillLocked: true,
        })}
        refusal={null}
        onFill={() => {}}
        onDownloadPdf={() => {}}
      />,
    );
    expect(screen.getByTestId("einvoice-fill-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("einvoice-fix-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("einvoice-issue-locked")).toBeInTheDocument();
  });
});

describe("EinvoicePanelBody summary", () => {
  it("names the buyer by the client name when the snapshot has no legal name", () => {
    render(
      <EinvoicePanelBody
        invoice={{
          ...INVOICE,
          issuer: { ...emptyBusinessProfile("ws"), legalName: "Example GmbH" },
          recipient: { ...EMPTY_CLIENT_BILLING, name: "Kunde AG", reference: "991-12345-06" },
          taxBreakdown: undefined,
        }}
        check={check({ ready: true })}
        refusal={null}
        onFill={() => {}}
        onDownloadPdf={() => {}}
      />,
    );
    const summary = screen.getByTestId("einvoice-snapshot-summary");
    expect(summary).toHaveTextContent("Example GmbH");
    expect(summary).toHaveTextContent("Kunde AG");
    expect(summary).toHaveTextContent("991-12345-06");
  });
});

describe("EinvoiceFillBody", () => {
  const fill = (overrides: Partial<EinvoiceFillPreview>): EinvoiceFillPreview => ({
    fields: ["issuer", "recipient.postalCode", "paymentTerms"],
    lineTax: "none",
    fixedTax: null,
    mismatch: null,
    ...overrides,
  });

  const renderFill = (preview: EinvoiceFillPreview, props: Partial<EinvoiceFillBodyProps> = {}) => {
    const onSubmit = vi.fn();
    render(
      <Dialog open>
        <DialogContent>
          <EinvoiceFillBody
            invoice={{ ...INVOICE, locale: "en" }}
            fill={preview}
            issuesAfterFill={[]}
            profile={{ ...emptyBusinessProfile("ws"), legalName: "Example GmbH" }}
            clientBilling={{ ...EMPTY_CLIENT_BILLING, postalCode: "80331" }}
            refusal={null}
            conflict={false}
            error={null}
            isPending={false}
            onSubmit={onSubmit}
            onCancel={() => {}}
            onReload={() => {}}
            onDownloadPdf={() => {}}
            {...props}
          />
        </DialogContent>
      </Dialog>,
    );
    return { onSubmit };
  };

  it("shows both figure sets for a mismatch and offers no confirm", () => {
    renderFill(
      fill({
        lineTax: "fixed",
        fixedTax: { category: "S", rate: 19 },
        mismatch: {
          stored: { subtotal: 1000, taxAmount: 190.01, total: 1190.01 },
          recomputed: { subtotal: 1000, taxAmount: 190, total: 1190 },
        },
      }),
    );
    expect(screen.getByTestId("einvoice-fill-mismatch-table")).toBeInTheDocument();
    expect(screen.getByTestId("einvoice-fill-mismatch-taxAmount")).toHaveAttribute("data-differs", "true");
    expect(screen.getByTestId("einvoice-fill-mismatch-subtotal")).toHaveAttribute("data-differs", "false");
    expect(screen.queryByTestId("einvoice-fill-confirm")).not.toBeInTheDocument();
  });

  it("states a fixed rate without a category choice", () => {
    renderFill(fill({ lineTax: "fixed", fixedTax: { category: "S", rate: 19 } }));
    expect(screen.getByTestId("einvoice-fill-tax-fixed")).toHaveTextContent("19 %");
    expect(screen.queryByTestId("einvoice-fill-zero-category")).not.toBeInTheDocument();
  });

  it("enables confirm only after a category is picked and the box is ticked", () => {
    const { onSubmit } = renderFill(fill({ lineTax: "choose" }));
    const confirm = screen.getByTestId("einvoice-fill-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId("einvoice-fill-confirm-check"));
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("einvoice-fill-zero-category"), { target: { value: "E" } });
    expect(screen.getByTestId("einvoice-fill-exemption-note")).not.toHaveValue("");
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inv1", confirm: true, zeroRateCategory: "E" }),
    );
  });

  it("lists one row per path it will fill, with today's value and where to edit it", () => {
    renderFill(fill({}));
    const rows = screen.getAllByTestId("einvoice-fill-field");
    expect(rows.map((row) => row.getAttribute("data-path"))).toEqual([
      "issuer",
      "recipient.postalCode",
      "paymentTerms",
    ]);
    expect(rows[0]).toHaveTextContent("Example GmbH");
    expect(rows[1]).toHaveTextContent("80331");
    const links = screen.getAllByTestId("einvoice-fill-edit-link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/app/settings?tab=billing&field=legalName&from=invoice:inv1",
      "/app/clients?billing=c1&field=postalCode&from=invoice:inv1",
    ]);
    // Payment terms are written from the frozen due date: nothing to type or edit.
    expect(screen.getByTestId("einvoice-fill-payment-terms-due")).toHaveTextContent("2026");
    expect(screen.queryByTestId("einvoice-fill-payment-terms")).not.toBeInTheDocument();
    expect(screen.getByTestId("einvoice-fill-also-on-pdf")).toBeInTheDocument();
  });

  it("names the VAT rows a legacy tax fill adds to the PDF, even with no party to copy", () => {
    renderFill(fill({ fields: [], lineTax: "choose" }));
    expect(screen.getByTestId("einvoice-fill-pdf-tax")).toBeInTheDocument();
    expect(screen.queryByTestId("einvoice-fill-pdf-parties")).not.toBeInTheDocument();
    cleanup();
    renderFill(fill({ fields: ["lineItems[*].taxCategory", "taxBreakdown", "paymentTerms"], lineTax: "fixed", fixedTax: { category: "S", rate: 19 } }));
    expect(screen.getByTestId("einvoice-fill-pdf-tax")).toBeInTheDocument();
    expect(screen.getByTestId("einvoice-fill-pdf-terms")).toBeInTheDocument();
  });

  it("offers no edit link for a deleted client", () => {
    renderFill(fill({ fields: ["recipient"] }), { clientBilling: null });
    expect(screen.getByTestId("einvoice-fill-field")).toHaveTextContent("Client deleted");
    expect(screen.queryByTestId("einvoice-fill-edit-link")).not.toBeInTheDocument();
  });
});

describe("einvoiceIssuesFromError", () => {
  it("reads the issues off a refusal and nothing off anything else", () => {
    const issues = [issue({})];
    expect(einvoiceIssuesFromError({ data: { einvoiceIssues: issues } })).toEqual(issues);
    expect(einvoiceIssuesFromError({ data: { code: "NOT_FOUND" } })).toBeNull();
    expect(einvoiceIssuesFromError("string")).toBeNull();
  });
});

describe("einvoiceFillRefusalFromError", () => {
  it("reads a known refusal code and nothing else", () => {
    expect(einvoiceFillRefusalFromError({ data: { einvoiceFillRefusal: "FILL_LOCKED_BY_ISSUED_XML" } })).toBe(
      "FILL_LOCKED_BY_ISSUED_XML",
    );
    expect(einvoiceFillRefusalFromError({ data: { einvoiceFillRefusal: "SOMETHING_NEW" } })).toBeNull();
    expect(einvoiceFillRefusalFromError({ data: { einvoiceFillRefusal: null } })).toBeNull();
  });
});
