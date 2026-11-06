// @vitest-environment jsdom
/**
 * Settings → Account: two-factor, password and email dialogs.
 *
 * What these pin: two-factor is switched on only after a code verifies, and
 * the backup codes appear once, after that; turning it off sends the
 * password; changing the password signs other devices out unless the person
 * unticks it; and a change of email says where the link went.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Result = { data?: unknown; error?: { code?: string } | null };

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const session = { data: { user: { twoFactorEnabled: false } } };
const enable = vi.fn<(args: { password: string }) => Promise<Result>>();
const verifyTotp = vi.fn<(args: { code: string }) => Promise<Result>>();
const disable = vi.fn<(args: { password: string; code?: string }) => Promise<Result>>();
const generateBackupCodes = vi.fn<(args: { password: string; code?: string }) => Promise<Result>>();
const changePassword = vi.fn<(args: unknown) => Promise<Result>>();
const changeEmail = vi.fn<(args: unknown) => Promise<Result>>();
const revokeOtherSessions = vi.fn<() => Promise<Result>>();

const toastSuccess = vi.fn();
vi.mock("@/components/ui/sonner", () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() } }));
const forgetTrusted = vi.fn(async () => ({ forgotten: 2 }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    devices: {
      forgetTrustedBrowsers: {
        useMutation: (options: { onSuccess?: (data: { forgotten: number }) => void }) => ({
          isPending: false,
          mutate: () => void forgetTrusted().then((data) => options.onSuccess?.(data)),
        }),
      },
    },
  },
}));
// Password unlock has its own tests; an account without parameters (legacy
// or an older server) sends both passwords as typed, which these tests pin.
vi.mock("@/lib/password-unlock", () => ({
  // The keys notice in the app shell: nothing to show.
  recoveryKeyToSave: () => null, passwordKeysNeedRecovery: () => false, passwordKeysStale: () => false,
  subscribePasswordUnlockNotices: () => () => {}, checkPasswordKeysStale: async () => {},
  passwordKdfOf: async () => null,
  passwordSecretFor: async (_email: string, password: string) => password,
  newPasswordSecretFor: async (_kdf: unknown, password: string) => ({ secret: password, wrappingKey: null }),
  rewrapKeysForPassword: async () => false,
  passwordSecretForSignedIn: async (password: string) => password,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => session,
    twoFactor: {
      enable: (args: { password: string }) => enable(args),
      verifyTotp: (args: { code: string }) => verifyTotp(args),
      disable: (args: { password: string }) => disable(args),
      generateBackupCodes: (args: { password: string }) => generateBackupCodes(args),
    },
    changePassword: (args: unknown) => changePassword(args),
    changeEmail: (args: unknown) => changeEmail(args),
    revokeOtherSessions: () => revokeOtherSessions(),
  },
  webCallbackUrl: (path: string) => `http://localhost:3392${path}`,
}));

const { TwoFactorRow, totpSecretOf } = await import("./two-factor");
const { ChangeEmailRow, ChangePasswordRow, passwordChangeProblem } = await import(
  "./account-credentials"
);

const URI = "otpauth://totp/Track%20Your%20Time:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Track%20Your%20Time&digits=6&period=30";
const CODES = ["aaaaa-11111", "bbbbb-22222", "ccccc-33333"];

beforeEach(() => {
  session.data.user.twoFactorEnabled = false;
  enable.mockReset().mockResolvedValue({ data: { totpURI: URI, backupCodes: CODES }, error: null });
  verifyTotp.mockReset().mockResolvedValue({ data: { token: "t" }, error: null });
  disable.mockReset().mockResolvedValue({ data: { status: true }, error: null });
  generateBackupCodes.mockReset().mockResolvedValue({ data: { status: true, backupCodes: ["NEW01-CODES"] }, error: null });
  changePassword.mockReset().mockResolvedValue({ data: { token: null }, error: null });
  changeEmail.mockReset().mockResolvedValue({ data: { status: true }, error: null });
  revokeOtherSessions.mockReset().mockResolvedValue({ data: { status: true }, error: null });
});

afterEach(() => cleanup());

const type = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

describe("turning two-factor on", () => {
  it("asks for the password, shows the QR code, and shows backup codes only after a code verifies", async () => {
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-enable"));

    type("two-factor-password", "password1234");
    fireEvent.click(screen.getByTestId("two-factor-password-submit"));
    expect(await screen.findByTestId("two-factor-qr")).toBeInTheDocument();
    expect(enable).toHaveBeenCalledWith({ password: "password1234" });
    expect(screen.getByTestId("two-factor-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    expect(screen.queryByTestId("two-factor-backup-codes")).toBeNull();

    type("two-factor-verify-code", "123456");
    fireEvent.click(screen.getByTestId("two-factor-verify-submit"));
    const codes = await screen.findByTestId("two-factor-backup-codes");
    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    for (const code of CODES) expect(codes).toHaveTextContent(code);
  });

  it("keeps the QR step and no codes when the code is wrong", async () => {
    verifyTotp.mockResolvedValue({ error: { code: "INVALID_CODE" } });
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-enable"));
    type("two-factor-password", "password1234");
    fireEvent.click(screen.getByTestId("two-factor-password-submit"));
    await screen.findByTestId("two-factor-qr");

    type("two-factor-verify-code", "000000");
    fireEvent.click(screen.getByTestId("two-factor-verify-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid/);
    expect(screen.queryByTestId("two-factor-backup-codes")).toBeNull();
  });

  it("reports a wrong password without moving on", async () => {
    enable.mockResolvedValue({ error: { code: "INVALID_PASSWORD" } });
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-enable"));
    type("two-factor-password", "nope-nope");
    fireEvent.click(screen.getByTestId("two-factor-password-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not correct/);
    expect(screen.queryByTestId("two-factor-qr")).toBeNull();
  });

  it("cannot be turned on by an account with no password", () => {
    render(<TwoFactorRow hasPassword={false} />);
    expect(screen.getByTestId("two-factor-enable")).toBeDisabled();
  });

  it("reads the secret out of the URI", () => {
    expect(totpSecretOf(URI)).toBe("JBSWY3DPEHPK3PXP");
    expect(totpSecretOf("not a uri")).toBe("");
  });
});

describe("turning two-factor off", () => {
  it("sends the password and the code, without the code's spaces", async () => {
    session.data.user.twoFactorEnabled = true;
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-disable"));
    type("two-factor-disable-password", "password1234");
    expect(screen.getByTestId("two-factor-disable-submit")).toBeDisabled();
    type("two-factor-disable-code", "123 456");
    fireEvent.click(screen.getByTestId("two-factor-disable-submit"));
    await waitFor(() =>
      expect(disable).toHaveBeenCalledWith({ password: "password1234", code: "123456" }),
    );
    await waitFor(() => expect(screen.queryByTestId("two-factor-disable-dialog")).toBeNull());
  });

  it("says when the code was wrong, and when there were too many", async () => {
    session.data.user.twoFactorEnabled = true;
    disable.mockResolvedValueOnce({ error: { code: "TWO_FACTOR_CODE_INVALID" } });
    disable.mockResolvedValueOnce({ error: { code: "TWO_FACTOR_TOO_MANY_ATTEMPTS" } });
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-disable"));
    type("two-factor-disable-password", "password1234");
    type("two-factor-disable-code", "000000");
    fireEvent.click(screen.getByTestId("two-factor-disable-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid/);
    fireEvent.click(screen.getByTestId("two-factor-disable-submit"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/15 minutes/));
    expect(screen.getByTestId("two-factor-disable-dialog")).toBeInTheDocument();
  });
});

describe("forgetting trusted browsers", () => {
  it("forgets them in one click and says how many", async () => {
    session.data.user.twoFactorEnabled = true;
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-forget-trusted"));
    await waitFor(() => expect(forgetTrusted).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Forgot 2 trusted browsers/)));
  });
});

describe("making new backup codes", () => {
  it("sends the password and a backup code as typed, then shows the new codes once", async () => {
    session.data.user.twoFactorEnabled = true;
    render(<TwoFactorRow hasPassword />);
    fireEvent.click(screen.getByTestId("two-factor-regenerate"));
    type("two-factor-regenerate-password", "password1234");
    type("two-factor-regenerate-code", " AbCdE-12345 ");
    fireEvent.click(screen.getByTestId("two-factor-regenerate-submit"));
    await waitFor(() =>
      expect(generateBackupCodes).toHaveBeenCalledWith({ password: "password1234", code: "AbCdE-12345" }),
    );
    expect(await screen.findByTestId("two-factor-backup-codes")).toHaveTextContent("NEW01-CODES");
    fireEvent.click(screen.getByTestId("two-factor-codes-done"));
    await waitFor(() => expect(screen.queryByTestId("two-factor-regenerate-dialog")).toBeNull());
  });
});

describe("changing the password", () => {
  const fill = (): void => {
    fireEvent.click(screen.getByTestId("change-password"));
    type("change-password-current", "password1234");
    type("change-password-new", "new-password-5678");
    type("change-password-confirm", "new-password-5678");
  };

  it("signs other devices out by default, keeping this device's session", async () => {
    render(<ChangePasswordRow hasPassword />);
    fill();
    fireEvent.click(screen.getByTestId("change-password-submit"));
    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalledTimes(1));
    // better-auth's own flag would replace this device's session too, and the
    // socket sweep would then sign this device out.
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "password1234",
      newPassword: "new-password-5678",
      revokeOtherSessions: false,
    });
  });

  it("keeps other devices signed in when unticked", async () => {
    render(<ChangePasswordRow hasPassword />);
    fill();
    fireEvent.click(screen.getByTestId("change-password-revoke"));
    fireEvent.click(screen.getByTestId("change-password-submit"));
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("change-password-dialog")).not.toBeInTheDocument(),
    );
    expect(revokeOtherSessions).not.toHaveBeenCalled();
  });

  it("does not sign other devices out when the password was refused", async () => {
    changePassword.mockResolvedValue({ error: { code: "INVALID_PASSWORD" } });
    render(<ChangePasswordRow hasPassword />);
    fill();
    fireEvent.click(screen.getByTestId("change-password-submit"));
    await screen.findByRole("alert");
    expect(revokeOtherSessions).not.toHaveBeenCalled();
  });

  it("stays open with a reason when the current password is wrong", async () => {
    changePassword.mockResolvedValue({ error: { code: "INVALID_PASSWORD" } });
    render(<ChangePasswordRow hasPassword />);
    fill();
    fireEvent.click(screen.getByTestId("change-password-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not correct/);
    expect(screen.getByTestId("change-password-dialog")).toBeInTheDocument();
  });

  it("checks the form before sending anything", () => {
    expect(passwordChangeProblem({ current: "", next: "abcdefgh", confirm: "abcdefgh" })).toMatch(/current/);
    expect(passwordChangeProblem({ current: "x", next: "short", confirm: "short" })).toMatch(/8/);
    expect(passwordChangeProblem({ current: "x", next: "abcdefgh", confirm: "abcdefgX" })).toMatch(/match/);
    expect(passwordChangeProblem({ current: "abcdefgh", next: "abcdefgh", confirm: "abcdefgh" })).toMatch(/same/);
    expect(passwordChangeProblem({ current: "x", next: "abcdefgh", confirm: "abcdefgh" })).toBeNull();
  });
});

describe("changing the email", () => {
  it("sends a link to the new address with a web callback", async () => {
    render(<ChangeEmailRow currentEmail="alice@example.com" mailConfigured />);
    fireEvent.click(screen.getByTestId("change-email"));
    type("change-email-input", "alice@work.example");
    fireEvent.click(screen.getByTestId("change-email-submit"));
    expect(await screen.findByTestId("change-email-sent")).toHaveTextContent(/We sent a link to alice@work.example/);
    expect(changeEmail).toHaveBeenCalledWith({
      newEmail: "alice@work.example",
      callbackURL: "http://localhost:3392/app/settings",
    });
  });

  it("says the link is in the server log when the server sends no mail", async () => {
    render(<ChangeEmailRow currentEmail="alice@example.com" mailConfigured={false} />);
    fireEvent.click(screen.getByTestId("change-email"));
    type("change-email-input", "alice@work.example");
    fireEvent.click(screen.getByTestId("change-email-submit"));
    expect(await screen.findByTestId("change-email-sent")).toHaveTextContent(/server log/);
  });

  it("refuses the current address", async () => {
    render(<ChangeEmailRow currentEmail="alice@example.com" mailConfigured />);
    fireEvent.click(screen.getByTestId("change-email"));
    type("change-email-input", "Alice@Example.com");
    fireEvent.click(screen.getByTestId("change-email-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already/);
    expect(changeEmail).not.toHaveBeenCalled();
  });
});
