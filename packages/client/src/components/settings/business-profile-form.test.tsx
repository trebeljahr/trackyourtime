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
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { BusinessProfileCard, inputFromDraft, parseTermsDraft, draftFromProfile } =
  await import("./business-profile-form");

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

    fireEvent.change(screen.getByTestId("business-profile-taxId"), {
      target: { value: "DE123" },
    });
    fireEvent.click(screen.getByTestId("business-profile-save"));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      legalName: "Alice Consulting",
      addressLines: ["Hauptstr. 1", ""],
      taxId: "DE123",
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
