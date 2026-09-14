// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EMPTY_CLIENT_BILLING, emptyBusinessProfile, type Client } from "@starter/shared";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { InvoiceIdentityWarnings } = await import("./identity-warnings");

const client = (billing: Client["billing"]): Client => ({
  id: "c1",
  workspaceId: "ws",
  createdBy: "u",
  name: "Acme GmbH",
  color: "#111111",
  archived: false,
  billing,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const completeProfile = {
  ...emptyBusinessProfile("ws"),
  legalName: "Alice Consulting",
  addressLines: ["Hauptstr. 1"],
  city: "Berlin",
};

afterEach(cleanup);

describe("InvoiceIdentityWarnings", () => {
  it("warns about an empty profile and a client without an address, with links to both", () => {
    render(
      <InvoiceIdentityWarnings
        profile={emptyBusinessProfile("ws")}
        client={client(null)}
      />,
    );
    expect(screen.getByTestId("invoice-warning-profile")).toBeInTheDocument();
    expect(screen.getByTestId("invoice-warning-profile-link")).toHaveAttribute(
      "href",
      "/settings?tab=billing",
    );
    expect(screen.getByTestId("invoice-warning-client")).toHaveTextContent("Acme GmbH");
    expect(screen.getByTestId("invoice-warning-client-link")).toHaveAttribute(
      "href",
      "/clients",
    );
  });

  it("says nothing when both parties have an address", () => {
    render(
      <InvoiceIdentityWarnings
        profile={completeProfile}
        client={client({
          ...EMPTY_CLIENT_BILLING,
          legalName: null,
          addressLines: [],
          postalCode: "20095",
          city: "Hamburg",
          country: "DE",
          taxId: null,
          email: null,
          reference: null,
        })}
      />,
    );
    expect(screen.queryByTestId("invoice-identity-warnings")).not.toBeInTheDocument();
  });

  it("does not warn about a profile it could not read, or a client not yet picked", () => {
    render(<InvoiceIdentityWarnings profile={undefined} client={null} />);
    expect(screen.queryByTestId("invoice-identity-warnings")).not.toBeInTheDocument();
  });

  it("a client whose billing details hold no address still warns", () => {
    render(
      <InvoiceIdentityWarnings
        profile={completeProfile}
        client={client({
          ...EMPTY_CLIENT_BILLING,
          legalName: "Acme Holding",
          addressLines: [],
          postalCode: null,
          city: null,
          country: null,
          taxId: "DE555",
          email: null,
          reference: "PO-7",
        })}
      />,
    );
    expect(screen.getByTestId("invoice-warning-client")).toBeInTheDocument();
    expect(screen.queryByTestId("invoice-warning-profile")).not.toBeInTheDocument();
  });
});
