// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyBusinessProfile, type BusinessProfile } from "@starter/shared";

/**
 * The business profile form: what it sends, what it refuses to send, and
 * the state a member whose role may not read the profile lands in — told why,
 * never handed an empty form they could not save anyway.
 */

type QueryState = {
  data?: BusinessProfile;
  error?: { data: { code: string } } | null;
  isError: boolean;
};

const query: { current: QueryState } = { current: { isError: false } };
const mutate = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ settings: { businessProfile: { setData: vi.fn() } } }),
    settings: {
      businessProfile: { useQuery: () => query.current },
      updateBusinessProfile: {
        useMutation: () => ({ mutate, isPending: false }),
      },
    },
  },
}));
vi.mock("@/hooks/use-sync", () => ({ ORIGIN_ID: "tab-test" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Radix's checkbox measures itself; jsdom has no ResizeObserver. */
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const {
  BusinessProfileCard,
  draftErrors,
  draftFromProfile,
  inputFromDraft,
  moveLegacyTaxId,
  parseTermsDraft,
  withSmallBusiness,
} = await import("./business-profile-form");

const saved = (): BusinessProfile => ({
  ...emptyBusinessProfile("ws"),
  legalName: "Alice Consulting",
  addressLines: ["Hauptstr. 1"],
  city: "Berlin",
  paymentTermsDays: 14,
  updatedAt: "2026-09-14T08:00:00.000Z",
});

beforeEach(() => {
  mutate.mockReset();
  query.current = { isError: false };
  window.history.replaceState({}, "", "/settings");
});
afterEach(cleanup);

describe("business profile helpers", () => {
  it("reads empty terms as no terms and refuses anything but whole days", () => {
    expect(parseTermsDraft("")).toEqual({ ok: true, value: null });
    expect(parseTermsDraft(" 30 ")).toEqual({ ok: true, value: 30 });
    expect(parseTermsDraft("7.5").ok).toBe(false);
    expect(parseTermsDraft("400").ok).toBe(false);
  });

  it("builds no payload while the country code is invalid", () => {
    const draft = { ...draftFromProfile(saved()), country: "Germany" };
    expect(inputFromDraft(draft)).toBeNull();
    expect(inputFromDraft({ ...draft, country: "de" })?.country).toBe("de");
  });
});

describe("BusinessProfileCard", () => {
  it("shows the stored profile and saves the edited one", () => {
    query.current = { data: saved(), isError: false };
    render(<BusinessProfileCard />);

    expect(screen.getByTestId("business-profile-legalName")).toHaveValue(
      "Alice Consulting",
    );
    expect(screen.getByTestId("business-profile-terms")).toHaveValue("14");

    // No legacy tax ID stored: the free-text input is not offered.
    expect(screen.queryByTestId("business-profile-taxId")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("business-profile-vatId"), {
      target: { value: "de 123 456 789" },
    });
    fireEvent.change(screen.getByTestId("business-profile-iban"), {
      target: { value: "DE02 1203 0000 0000 2020 51" },
    });
    fireEvent.click(screen.getByTestId("business-profile-save"));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      legalName: "Alice Consulting",
      addressLines: ["Hauptstr. 1", ""],
      taxId: "",
      vatId: "DE123456789",
      iban: "DE02120300000000202051",
      electronicAddress: null,
      electronicAddressScheme: null,
      smallBusiness: false,
      defaultTaxCategory: null,
      defaultTaxRate: null,
      paymentTermsDays: 14,
      originId: "tab-test",
    });
  });

  it("does not send terms it cannot read", () => {
    query.current = { data: saved(), isError: false };
    render(<BusinessProfileCard />);
    fireEvent.change(screen.getByTestId("business-profile-terms"), {
      target: { value: "two weeks" },
    });
    expect(screen.getByTestId("business-profile-terms-error")).toBeInTheDocument();
    expect(screen.getByTestId("business-profile-save")).toBeDisabled();
  });

  it("tells a member their role hides the profile instead of showing a form", () => {
    query.current = { error: { data: { code: "FORBIDDEN" } }, isError: true };
    render(<BusinessProfileCard />);
    expect(screen.getByTestId("business-profile-hidden")).toBeInTheDocument();
    expect(screen.queryByTestId("business-profile-form")).not.toBeInTheDocument();
  });
});

describe("e-invoice fields", () => {
  it("refuses an invalid VAT ID, IBAN or electronic address inline and blocks Save", () => {
    query.current = { data: saved(), isError: false };
    render(<BusinessProfileCard />);

    fireEvent.change(screen.getByTestId("business-profile-vatId"), { target: { value: "123" } });
    expect(screen.getByTestId("business-profile-vatId-error")).toBeInTheDocument();
    expect(screen.getByTestId("business-profile-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("business-profile-vatId"), { target: { value: "" } });

    fireEvent.change(screen.getByTestId("business-profile-iban"), {
      target: { value: "DE03 1203 0000 0000 2020 51" },
    });
    expect(screen.getByTestId("business-profile-iban-error")).toHaveTextContent("check digits");
    fireEvent.change(screen.getByTestId("business-profile-iban"), { target: { value: "" } });

    fireEvent.change(screen.getByTestId("business-profile-electronicAddressScheme"), {
      target: { value: "0204" },
    });
    fireEvent.change(screen.getByTestId("business-profile-electronicAddress"), {
      target: { value: "not a leitweg id" },
    });
    expect(screen.getByTestId("business-profile-electronicAddress-error")).toBeInTheDocument();
    expect(screen.getByTestId("business-profile-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("business-profile-electronicAddress"), {
      target: { value: "991-12345-06" },
    });
    expect(screen.getByTestId("business-profile-save")).toBeEnabled();
    fireEvent.click(screen.getByTestId("business-profile-save"));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      electronicAddress: "991-12345-06",
      electronicAddressScheme: "0204",
    });
  });

  it("gives a formatted VAT ID room in its input", () => {
    query.current = { data: saved(), isError: false };
    render(<BusinessProfileCard />);
    const input = screen.getByTestId("business-profile-vatId");
    expect(Number(input.getAttribute("maxLength"))).toBeGreaterThan(20);
  });

  it("offers the legacy tax ID only while one is stored, and moves it on request", () => {
    query.current = { data: { ...saved(), taxId: "12/345/67890" }, isError: false };
    render(<BusinessProfileCard />);
    expect(screen.getByTestId("business-profile-taxId")).toHaveValue("12/345/67890");
    fireEvent.click(screen.getByTestId("business-profile-taxid-use-number"));
    expect(screen.getByTestId("business-profile-taxNumber")).toHaveValue("12/345/67890");
    expect(screen.queryByTestId("business-profile-legacy-taxid")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("business-profile-save"));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ taxId: "", taxNumber: "12/345/67890" });
  });

  it("keeps the legacy tax ID input while its text is cleared to be retyped", () => {
    query.current = { data: { ...saved(), taxId: "12/345/67890" }, isError: false };
    render(<BusinessProfileCard />);
    fireEvent.change(screen.getByTestId("business-profile-taxId"), { target: { value: "" } });
    expect(screen.getByTestId("business-profile-taxId")).toHaveValue("");
    fireEvent.change(screen.getByTestId("business-profile-taxId"), { target: { value: "12/345/67891" } });
    expect(screen.getByTestId("business-profile-taxId")).toHaveValue("12/345/67891");
  });

  it("focuses and highlights the field a deep link names, and links back to the invoice", () => {
    window.history.replaceState({}, "", "/settings?tab=billing&field=iban&from=invoice:inv1");
    query.current = { data: saved(), isError: false };
    render(<BusinessProfileCard />);
    expect(screen.getByTestId("business-profile-iban")).toHaveFocus();
    expect(screen.getByTestId("business-profile-iban").closest("[data-field]")).toHaveAttribute(
      "data-highlight",
      "true",
    );
    expect(screen.getByTestId("business-profile-back-to-invoice")).toHaveAttribute(
      "href",
      "/invoices?invoice=inv1",
    );
  });
});

describe("draft rules", () => {
  it("moves a legacy tax ID only into an empty field", () => {
    const draft = { ...draftFromProfile(saved()), taxId: "DE999999999" };
    expect(moveLegacyTaxId(draft, "vatId")).toMatchObject({ vatId: "DE999999999", taxId: "" });
    expect(moveLegacyTaxId({ ...draft, vatId: "DE123456789" }, "vatId")).toMatchObject({
      vatId: "DE123456789",
      taxId: "DE999999999",
    });
  });

  it("pre-fills a small business with exempt and its note, and refuses another default", () => {
    const draft = withSmallBusiness(draftFromProfile(saved()), true, "de");
    expect(draft.defaultTax).toEqual({ kind: "E" });
    expect(draft.smallBusinessNote).toContain("§ 19 UStG");
    expect(inputFromDraft(draft)).toMatchObject({
      smallBusiness: true,
      defaultTaxCategory: "E",
      defaultTaxRate: 0,
    });
    const conflicting = { ...draft, defaultTax: { kind: "S19" as const } };
    expect(draftErrors(conflicting).defaultTax).toBe("smallBusinessNeedsE");
    expect(inputFromDraft(conflicting)).toBeNull();
  });

  it("reads a stored default back as the same choice", () => {
    const draft = draftFromProfile({ ...saved(), defaultTaxCategory: "S", defaultTaxRate: 19 });
    expect(draft.defaultTax).toEqual({ kind: "S19" });
    expect(inputFromDraft(draft)).toMatchObject({ defaultTaxCategory: "S", defaultTaxRate: 19 });
  });
});
