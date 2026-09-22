// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BUSINESS_LOGO_MAX_BYTES,
  BUSINESS_LOGO_REFUSALS,
  emptyBusinessProfile,
  type BusinessProfile,
} from "@starter/shared";

/**
 * The logo control: what it sends (the file as base64 with its type), what it
 * refuses before reading (the wrong type, a file over the cap), how a server
 * refusal is shown, and that a saved logo is merged into the cached profile
 * without moving `updatedAt` — the value the form beside it is keyed on.
 */

type MutationOptions = {
  onSuccess?: (saved: BusinessProfile) => void;
  onError?: (error: { message: string; data?: { code: string } }) => void;
};

const setMutate = vi.fn();
const clearMutate = vi.fn();
const setData = vi.fn();
const captured: { set?: MutationOptions; clear?: MutationOptions } = {};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ settings: { businessProfile: { setData } } }),
    settings: {
      setBusinessLogo: {
        useMutation: (options: MutationOptions) => {
          captured.set = options;
          return { mutate: setMutate, isPending: false };
        },
      },
      clearBusinessLogo: {
        useMutation: (options: MutationOptions) => {
          captured.clear = options;
          return { mutate: clearMutate, isPending: false };
        },
      },
    },
  },
}));
vi.mock("@/hooks/use-sync", () => ({ ORIGIN_ID: "tab-test" }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("@/components/ui/sonner", () => ({ toast }));

const { BusinessLogoControl, checkLogoFile, readLogoFile } = await import("./business-logo");

// A 1×1 PNG. The bytes are the server's to check; the control sends them as they are.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngFile = (name = "logo.png"): File =>
  new File([Uint8Array.from(Buffer.from(PNG_BASE64, "base64"))], name, { type: "image/png" });

const withLogo = (): BusinessProfile => ({
  ...emptyBusinessProfile("ws"),
  legalName: "Alice Consulting",
  logo: { dataUrl: `data:image/png;base64,${PNG_BASE64}`, width: 240, height: 80 },
  updatedAt: "2026-09-14T08:00:00.000Z",
});

const pick = (file: File): void => {
  const input = screen.getByTestId("business-logo-file");
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => {
  setMutate.mockReset();
  clearMutate.mockReset();
  setData.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

describe("checkLogoFile and readLogoFile", () => {
  it("refuses the wrong type and a file over the cap before reading anything", () => {
    expect(checkLogoFile({ type: "image/svg+xml", size: 10 })).toBe(BUSINESS_LOGO_REFUSALS.unsupportedFormat);
    expect(checkLogoFile({ type: "", size: 10 })).toBe(BUSINESS_LOGO_REFUSALS.unsupportedFormat);
    expect(checkLogoFile({ type: "image/png", size: BUSINESS_LOGO_MAX_BYTES + 1 })).toBe(
      BUSINESS_LOGO_REFUSALS.tooLarge,
    );
    expect(checkLogoFile({ type: "image/png", size: BUSINESS_LOGO_MAX_BYTES })).toBeNull();
    expect(checkLogoFile({ type: "image/jpeg", size: 1 })).toBeNull();
  });

  it("reads a file as its type and base64 body", async () => {
    await expect(readLogoFile(pngFile())).resolves.toEqual({ mime: "image/png", base64: PNG_BASE64 });
  });
});

describe("BusinessLogoControl", () => {
  it("offers an upload and no preview while there is no logo", () => {
    render(<BusinessLogoControl profile={emptyBusinessProfile("ws")} />);
    expect(screen.getByTestId("business-logo-empty")).toBeInTheDocument();
    expect(screen.getByTestId("business-logo-size")).toHaveTextContent("No logo yet.");
    expect(screen.getByTestId("business-logo-upload")).toHaveTextContent("Upload logo");
    expect(screen.queryByTestId("business-logo-remove")).toBeNull();
    expect(screen.getByText(/up to 300 KB/)).toBeInTheDocument();
  });

  it("previews the stored logo with its size, and offers replace and remove", () => {
    render(<BusinessLogoControl profile={withLogo()} />);
    const preview = screen.getByTestId("business-logo-preview");
    expect(preview).toHaveAttribute("src", `data:image/png;base64,${PNG_BASE64}`);
    expect(screen.getByTestId("business-logo-size")).toHaveTextContent("240 × 80 px");
    expect(screen.getByTestId("business-logo-upload")).toHaveTextContent("Replace");
    fireEvent.click(screen.getByTestId("business-logo-remove"));
    expect(clearMutate).toHaveBeenCalledWith({ originId: "tab-test" });
  });

  it("sends a picked PNG as its type and base64 body", async () => {
    render(<BusinessLogoControl profile={emptyBusinessProfile("ws")} />);
    pick(pngFile());
    await waitFor(() =>
      expect(setMutate).toHaveBeenCalledWith({ mime: "image/png", base64: PNG_BASE64, originId: "tab-test" }),
    );
    expect(screen.queryByTestId("business-logo-error")).toBeNull();
  });

  it("refuses the wrong type and a file over the cap without sending, and says why", async () => {
    render(<BusinessLogoControl profile={emptyBusinessProfile("ws")} />);
    pick(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    expect(screen.getByTestId("business-logo-error")).toHaveTextContent("Choose a PNG or JPEG file.");

    pick(new File([new Uint8Array(BUSINESS_LOGO_MAX_BYTES + 1)], "big.png", { type: "image/png" }));
    expect(screen.getByTestId("business-logo-error")).toHaveTextContent("larger than 300 KB");
    expect(setMutate).not.toHaveBeenCalled();

    // A good file afterwards clears the message.
    pick(pngFile());
    await waitFor(() => expect(setMutate).toHaveBeenCalled());
    expect(screen.queryByTestId("business-logo-error")).toBeNull();
  });

  it("shows a server refusal by its code, and toasts any other failure", () => {
    render(<BusinessLogoControl profile={emptyBusinessProfile("ws")} />);
    act(() => captured.set?.onError?.({ message: BUSINESS_LOGO_REFUSALS.cmykJpeg, data: { code: "BAD_REQUEST" } }));
    expect(screen.getByTestId("business-logo-error")).toHaveTextContent("CMYK JPEGs cannot be printed.");
    act(() => captured.set?.onError?.({ message: BUSINESS_LOGO_REFUSALS.tooBig, data: { code: "BAD_REQUEST" } }));
    expect(screen.getByTestId("business-logo-error")).toHaveTextContent("larger than 2000 px");
    expect(toast.error).not.toHaveBeenCalled();

    act(() => captured.set?.onError?.({ message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } }));
    expect(toast.error).toHaveBeenCalledWith("The logo could not be saved. Try again.");
    act(() => captured.set?.onError?.({ message: "no", data: { code: "FORBIDDEN" } }));
    expect(toast.error).toHaveBeenLastCalledWith("Only an owner or admin can change the business profile.");
  });

  it("merges only the logo into the cached profile, keeping updatedAt for the form's key", () => {
    render(<BusinessLogoControl profile={emptyBusinessProfile("ws")} />);
    const saved = { ...withLogo(), updatedAt: "2026-09-20T00:00:00.000Z" };
    act(() => captured.set?.onSuccess?.(saved));
    expect(toast.success).toHaveBeenCalledWith("Logo saved");
    expect(setData).toHaveBeenCalledTimes(1);
    const updater = setData.mock.calls[0]?.[1] as (current: BusinessProfile | undefined) => BusinessProfile;
    const cached = { ...emptyBusinessProfile("ws"), legalName: "Draft Co", updatedAt: "2026-09-14T08:00:00.000Z" };
    expect(updater(cached)).toEqual({ ...cached, logo: saved.logo });
    expect(updater(undefined)).toEqual(saved);

    act(() => captured.clear?.onSuccess?.({ ...saved, logo: null }));
    expect(toast.success).toHaveBeenLastCalledWith("Logo removed");
    const cleared = setData.mock.calls[1]?.[1] as (current: BusinessProfile | undefined) => BusinessProfile;
    expect(cleared(cached).logo).toBeNull();
  });
});
