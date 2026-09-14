import { translate } from "@/i18n/translate";

/** The part of a better-auth client error a sign-in screen can act on. */
export type AuthErrorLike = {
  code?: string;
  status?: number;
};

/**
 * The message a login or signup form shows for a refusal, in the rendered
 * language.
 *
 * Mapped from better-auth's error CODE, never its `message`: the message is
 * English text written by the library, and would be the one English sentence
 * on a German screen. A code with no mapping falls back to the form's own
 * generic refusal rather than leaking that text.
 *
 * Call it where the error is handled, not at module scope — `translate` reads
 * the locale at call time.
 */
export const authErrorMessage = (
  error: AuthErrorLike,
  form: "login" | "signup",
): string => {
  const t = translate("shell");
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return t("auth.errors.invalidCredentials");
    case "INVALID_EMAIL":
      return t("auth.errors.invalidEmail");
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return t("auth.errors.userExists");
    case "PASSWORD_TOO_SHORT":
      return t("auth.errors.passwordTooShort");
    case "PASSWORD_TOO_LONG":
      return t("auth.errors.passwordTooLong");
    default:
      break;
  }
  if (error.status === 429) return t("auth.errors.tooManyRequests");
  return form === "login" ? t("auth.errors.loginFailed") : t("auth.errors.signupFailed");
};
