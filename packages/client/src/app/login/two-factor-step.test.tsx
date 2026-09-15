// @vitest-environment jsdom
/**
 * /login for an account with two-factor authentication.
 *
 * What these pin: a password answered with a challenge never navigates —
 * only a verified code does; a wrong code stays on the step with a reason; a
 * backup code goes to its own endpoint; an expired challenge goes back to the
 * password; and a native shell gets an error instead of a step it could never
 * complete.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Result = { data?: unknown; error?: { code?: string; message?: string } | null };

const replace = vi.fn();
const getSession = vi.fn(async () => undefined);
const signInEmail = vi.fn<(args: unknown) => Promise<Result>>();
const verifyTotp = vi.fn<(args: { code: string }) => Promise<Result>>();
const verifyBackupCode = vi.fn<(args: { code: string }) => Promise<Result>>();
const sendVerificationEmail = vi.fn(async (_args: unknown) => ({ data: { status: true }, error: null }));
let native = false;

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/mobile/bridge", () => ({ isNative: () => native }));
vi.mock("@/components/google-sign-in-button", () => ({ GoogleSignInButton: () => null }));
vi.mock("@/lib/auth-client", () => ({
  signIn: { email: (args: unknown) => signInEmail(args) },
  getSession: () => getSession(),
  authClient: {
    sendVerificationEmail: (args: unknown) => sendVerificationEmail(args),
    twoFactor: {
      verifyTotp: (args: { code: string }) => verifyTotp(args),
      verifyBackupCode: (args: { code: string }) => verifyBackupCode(args),
    },
  },
  isTwoFactorChallenge: (data: unknown) =>
    (data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true,
  webCallbackUrl: (path: string) => `http://localhost${path}`,
  POST_AUTH_REDIRECT: "/app/track",
}));

const { default: LoginPage } = await import("./page");
const { en } = await import("@/i18n/messages");
const NATIVE_TWO_FACTOR_UNSUPPORTED = en.shell.auth.twoFactor.nativeUnsupported;
const EMAIL_NOT_VERIFIED_MESSAGE = en.shell.auth.login.emailNotVerified;

const submitPassword = async (): Promise<void> => {
  render(<LoginPage />);
  fireEvent.change(screen.getByTestId("login-email"), { target: { value: "alice@example.com" } });
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: "password1234" } });
  fireEvent.click(screen.getByTestId("login-submit"));
};

const enterCode = (code: string): void => {
  fireEvent.change(screen.getByTestId("two-factor-code"), { target: { value: code } });
  fireEvent.click(screen.getByTestId("two-factor-submit"));
};

beforeEach(() => {
  native = false;
  replace.mockReset();
  signInEmail.mockReset().mockResolvedValue({
    data: { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
    error: null,
  });
  verifyTotp.mockReset().mockResolvedValue({ data: { token: "t" }, error: null });
  verifyBackupCode.mockReset().mockResolvedValue({ data: { token: "t" }, error: null });
});

afterEach(() => cleanup());

describe("the two-factor step on /login", () => {
  it("asks for a code instead of navigating, and navigates once it verifies", async () => {
    await submitPassword();
    await screen.findByTestId("login-two-factor");
    expect(replace).not.toHaveBeenCalled();

    enterCode("123 456");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/track"));
    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    expect(getSession).toHaveBeenCalled();
  });

  it("keeps a wrong code on the step with a reason", async () => {
    verifyTotp.mockResolvedValue({ error: { code: "INVALID_CODE" } });
    await submitPassword();
    await screen.findByTestId("login-two-factor");

    enterCode("000000");
    expect(await screen.findByTestId("two-factor-error")).toHaveTextContent(/not valid/);
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends a backup code to the backup-code endpoint", async () => {
    await submitPassword();
    await screen.findByTestId("login-two-factor");
    fireEvent.click(screen.getByTestId("two-factor-switch"));

    enterCode("abcde-fghij");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/track"));
    expect(verifyBackupCode).toHaveBeenCalledWith({ code: "abcde-fghij" });
    expect(verifyTotp).not.toHaveBeenCalled();
  });

  it("reports a used backup code", async () => {
    verifyBackupCode.mockResolvedValue({ error: { code: "INVALID_BACKUP_CODE" } });
    await submitPassword();
    await screen.findByTestId("login-two-factor");
    fireEvent.click(screen.getByTestId("two-factor-switch"));

    enterCode("abcde-fghij");
    expect(await screen.findByTestId("two-factor-error")).toHaveTextContent(/already been used/);
  });

  it("goes back to the password when the challenge expired", async () => {
    verifyTotp.mockResolvedValue({ error: { code: "INVALID_TWO_FACTOR_COOKIE" } });
    await submitPassword();
    await screen.findByTestId("login-two-factor");

    enterCode("123456");
    expect(await screen.findByTestId("login-error")).toHaveTextContent(/too long/);
    expect(screen.getByTestId("login-password")).toHaveValue("");
  });

  it("gives a native shell an error, not a step it cannot complete", async () => {
    native = true;
    await submitPassword();
    expect(await screen.findByTestId("login-error")).toHaveTextContent(NATIVE_TWO_FACTOR_UNSUPPORTED);
    expect(screen.queryByTestId("login-two-factor")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("explains an unverified email and sends a link that lands on the web app", async () => {
    signInEmail.mockResolvedValue({ error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" } });
    await submitPassword();
    expect(await screen.findByTestId("login-error")).toHaveTextContent(EMAIL_NOT_VERIFIED_MESSAGE);
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "alice@example.com",
      callbackURL: "http://localhost/login",
    });
  });

  it("never sends a callbackURL with the password, which would reload the page", async () => {
    signInEmail.mockResolvedValue({ data: { token: "t", user: {} }, error: null });
    await submitPassword();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(signInEmail).toHaveBeenCalledWith({ email: "alice@example.com", password: "password1234" });
  });

  it("signs a plain account straight in", async () => {
    signInEmail.mockResolvedValue({ data: { token: "t", user: {} }, error: null });
    await submitPassword();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/track"));
    expect(screen.queryByTestId("login-two-factor")).toBeNull();
  });
});
