/**
 * The pending two-factor sign-in challenge, between the password step and the
 * code step of /login.
 *
 * The server hands it out as the `set-two-factor-token` response header and
 * takes it back as `x-two-factor-token` on the verify call
 * (`auth/two-factor-guard.ts`). Every client uses the header — the web app
 * too, where the `two_factor` cookie would also work — so one transport is
 * what Playwright exercises and what the phone and desktop apps, which carry
 * no cookies, depend on.
 *
 * Memory only. The challenge is half a credential (the password half), lasts
 * ten minutes, and a reload costs one password retype.
 */
import {
  TWO_FACTOR_CHALLENGE_REQUEST_HEADER,
  TWO_FACTOR_CHALLENGE_RESPONSE_HEADER,
} from "@starter/shared";

let pending: string | null = null;

const SIGN_IN_PATH = /\/sign-in\/email$/;
const VERIFY_PATH = /\/two-factor\/verify-(totp|backup-code)$/;

/** Whether a password sign-in left a challenge this client can answer. */
export const hasTwoFactorChallenge = (): boolean => pending !== null;

export function forgetTwoFactorChallenge(): void {
  pending = null;
}

/** Whether `url` is one of the calls that carry or answer the challenge. */
export const isTwoFactorTransportPath = (url: string): boolean => {
  const path = new URL(url, "http://localhost").pathname;
  return SIGN_IN_PATH.test(path) || VERIFY_PATH.test(path);
};

/** Put the pending challenge on a verify request. */
export function withTwoFactorChallenge(url: string, headers: Headers): Headers {
  const path = new URL(url, "http://localhost").pathname;
  if (pending && VERIFY_PATH.test(path)) headers.set(TWO_FACTOR_CHALLENGE_REQUEST_HEADER, pending);
  return headers;
}

/**
 * Remember (or forget) the challenge after a response. A sign-in replaces it
 * (with nothing, when it signed straight in or failed);
 * a successful verify ends it. A refused verify keeps it: a wrong code may be
 * retried until the server drops the challenge, which it answers with its own
 * code.
 */
export function rememberTwoFactorChallenge(url: string, response: Response): void {
  const path = new URL(url, "http://localhost").pathname;
  if (SIGN_IN_PATH.test(path)) {
    pending = response.ok ? response.headers.get(TWO_FACTOR_CHALLENGE_RESPONSE_HEADER) : null;
  } else if (VERIFY_PATH.test(path) && response.ok) {
    pending = null;
  }
}
