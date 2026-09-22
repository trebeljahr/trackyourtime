// @vitest-environment jsdom
/**
 * The profile picture control: what it offers with and without a picture,
 * that a chosen file goes out squared as base64, and that a refusal is told
 * in words rather than as a server code.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AVATAR_REFUSALS } from "@starter/shared";

const user: { current: { id: string; name: string; email: string; image?: string } | null } = {
  current: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
};
const setAvatar = vi.fn<(input: { data: string }) => Promise<unknown>>();
const removeAvatar = vi.fn<() => Promise<unknown>>();
const refreshSession = vi.fn<() => Promise<void>>();
const prepareAvatar = vi.fn<(file: File) => Promise<{ base64: string; contentType: string; bytes: number }>>();
const toast = { success: vi.fn(), error: vi.fn() };

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: user.current }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    profile: {
      setAvatar: { useMutation: () => ({ mutateAsync: setAvatar, isPending: false }) },
      removeAvatar: { useMutation: () => ({ mutateAsync: removeAvatar, isPending: false }) },
    },
  },
}));
vi.mock("@/lib/auth-client", () => ({ refreshSession: () => refreshSession() }));
vi.mock("@/lib/avatar-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/avatar-image")>()),
  prepareAvatar: (file: File) => prepareAvatar(file),
}));
vi.mock("@/components/ui/sonner", () => ({ toast }));

const { ProfilePicture, initialsOf, avatarFailureMessage } = await import("./profile-picture");
const { PrepareAvatarError } = await import("@/lib/avatar-image");

beforeEach(() => {
  user.current = { id: "u1", name: "Ada Lovelace", email: "ada@example.com" };
  setAvatar.mockReset().mockResolvedValue({ image: "https://api.test/api/avatars/u1/k" });
  removeAvatar.mockReset().mockResolvedValue({ image: null });
  refreshSession.mockReset().mockResolvedValue();
  prepareAvatar.mockReset().mockResolvedValue({ base64: "QUJD", contentType: "image/webp", bytes: 3 });
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

describe("initialsOf", () => {
  it("takes the first letters of the name, else of the email", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("  ", "ada@example.com")).toBe("A");
    expect(initialsOf(null, null)).toBe("?");
  });
});

describe("ProfilePicture", () => {
  it("offers only an upload while there is no picture", () => {
    render(<ProfilePicture />);
    expect(screen.getByTestId("profile-picture-upload")).toHaveTextContent("Upload picture");
    expect(screen.queryByTestId("profile-picture-remove")).toBeNull();
    expect(screen.queryByTestId("profile-picture-image")).toBeNull();
  });

  it("offers change and remove once there is one", () => {
    user.current = { ...user.current!, image: "https://api.test/api/avatars/u1/k" };
    render(<ProfilePicture />);
    expect(screen.getByTestId("profile-picture-upload")).toHaveTextContent("Change picture");
    expect(screen.getByTestId("profile-picture-remove")).toBeInTheDocument();
  });

  it("sends the prepared bytes and re-reads the session", async () => {
    render(<ProfilePicture />);
    const file = new File([new Uint8Array([1, 2, 3])], "me.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("profile-picture-input"), { target: { files: [file] } });
    await waitFor(() => expect(setAvatar).toHaveBeenCalledWith({ data: "QUJD" }));
    expect(prepareAvatar).toHaveBeenCalledWith(file);
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Profile picture saved");
  });

  it("tells the person why a file was refused, in words", async () => {
    prepareAvatar.mockRejectedValue(new PrepareAvatarError("not-an-image"));
    render(<ProfilePicture />);
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("profile-picture-input"), { target: { files: [file] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0][0]).toMatch(/not an image/);
    expect(setAvatar).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("removes and re-reads the session", async () => {
    user.current = { ...user.current!, image: "https://api.test/api/avatars/u1/k" };
    render(<ProfilePicture />);
    fireEvent.click(screen.getByTestId("profile-picture-remove"));
    await waitFor(() => expect(removeAvatar).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Profile picture removed");
  });
});

describe("avatarFailureMessage", () => {
  it("translates the server's refusal codes", () => {
    expect(avatarFailureMessage({ message: AVATAR_REFUSALS.TOO_LARGE })).toMatch(/too large/);
    expect(avatarFailureMessage({ message: AVATAR_REFUSALS.UNSUPPORTED_IMAGE })).toMatch(/not an image/);
    expect(avatarFailureMessage(new PrepareAvatarError("too-large"))).toMatch(/too large/);
  });
});
