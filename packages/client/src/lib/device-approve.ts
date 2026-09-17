/**
 * Approving or declining an RFC 8628 user code with this page's session.
 *
 * Two callers: the `/app/device` page, where a person types or follows a code,
 * and the extension bridge (`lib/extension-bridge.ts`), which approves a code
 * the extension handed it in a reply. Both need the same two requests in the
 * same order, which is why they live here once.
 *
 * better-auth requires the code to be *claimed* by a signed-in session
 * (`GET /device?user_code=…`) before it accepts an approve or deny. Approving
 * without it fails with `invalid_request`, which reads to the user like a
 * mistyped code — so claim first and report a bad code once.
 */
import { authClient } from "@/lib/auth-client";

/** The error shape better-auth's device endpoints answer with. */
export type DeviceAuthError = {
  /** The RFC 8628 code (`invalid_request`, `expired_token`, …). */
  error?: string;
  error_description?: string;
  message?: string;
};

export type DeviceCodeDecision = "approve" | "deny";

export type DeviceCodeResult =
  | { ok: true }
  | {
      ok: false;
      /** Which request refused: the claim, or the approve/deny itself. */
      stage: "claim" | "decide";
      error: DeviceAuthError;
    }
  /** No answer at all — the request threw. */
  | { ok: false; stage: "network" };

export type DeviceCodeOptions = {
  /**
   * Treat a code that is already approved as a success. For the bridge only:
   * two tabs of one browser can be handed the same code, and the one that
   * loses the race has still got what it wanted. The `/app/device` page keeps
   * reporting it, because a person who approves twice should be told.
   */
  alreadyApprovedIsOk?: boolean;
};

/**
 * better-auth returns `{ data, error }` rather than throwing, and its typings
 * for the device plugin are loose, so the result is read structurally.
 */
type AuthResult = {
  data?: unknown;
  error?: DeviceAuthError | null;
};

const ALREADY_PROCESSED = "Device code already processed";

const claimedStatus = (result: AuthResult): string | null => {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("status" in data)) return null;
  return typeof data.status === "string" ? data.status : null;
};

const claim = async (userCode: string): Promise<AuthResult> =>
  (await authClient.device({ query: { user_code: userCode } })) as AuthResult;

/** Claim `userCode` for this session, then approve or deny it. Never throws. */
export const decideDeviceCode = async (
  userCode: string,
  decision: DeviceCodeDecision,
  options: DeviceCodeOptions = {},
): Promise<DeviceCodeResult> => {
  try {
    const claimed = await claim(userCode);
    if (claimed.error) return { ok: false, stage: "claim", error: claimed.error };

    if (options.alreadyApprovedIsOk && decision === "approve") {
      if (claimedStatus(claimed) === "approved") return { ok: true };
    }

    const result = (
      decision === "approve"
        ? await authClient.device.approve({ userCode })
        : await authClient.device.deny({ userCode })
    ) as AuthResult;
    if (!result.error) return { ok: true };

    // Another tab approved between the claim and the approve. Ask once more
    // rather than trusting the message: "already processed" is also what a
    // DENIED code says.
    if (
      options.alreadyApprovedIsOk &&
      decision === "approve" &&
      result.error.error === "invalid_request" &&
      result.error.error_description === ALREADY_PROCESSED
    ) {
      const again = await claim(userCode);
      if (!again.error && claimedStatus(again) === "approved") return { ok: true };
    }
    return { ok: false, stage: "decide", error: result.error };
  } catch {
    return { ok: false, stage: "network" };
  }
};

export const approveDeviceCode = (
  userCode: string,
  options: DeviceCodeOptions = {},
): Promise<DeviceCodeResult> => decideDeviceCode(userCode, "approve", options);

export const denyDeviceCode = (userCode: string): Promise<DeviceCodeResult> =>
  decideDeviceCode(userCode, "deny");
