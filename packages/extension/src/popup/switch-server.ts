/**
 * Switching the server the extension talks to, as plain functions.
 *
 * Kept out of the picker component so the one ordering rule that matters can
 * be tested without React or a DOM: Chrome only honours
 * `chrome.permissions.request` inside the click that asked for it, and the
 * click's user gesture does not survive an `await`. So, in this order and with
 * nothing awaited before the second step:
 *
 *   1. `normalizeServerInput` — synchronous, and stops a typo before Chrome is
 *      asked about a host nobody meant.
 *   2. `requestServerAccess` — calls `permissions.request` before returning.
 *   3. Only then the worker, which checks the server over the network and
 *      does the actual switch.
 *
 * A server can be refused at step 3 after access was granted at step 2 — it is
 * not running, or it is not Track Your Time. The grant is then handed back,
 * so a failed attempt does not leave a standing permission for a host the
 * extension never uses.
 */
import {
  normalizeServerInput,
  sameServerOrigin,
  serverHost,
} from "@starter/core";
import {
  requestServerAccess,
  releaseServerAccess,
  sharesServerAccess,
  type PermissionsApi,
} from "../lib/server-access";

/**
 * The worker's answer to `config:set-server`.
 *
 * `code` is carried through so the caller can tell "the queue has unsent
 * changes" (ask, then retry) apart from "that is not a server" (show it).
 */
export type SetServerOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** The worker refused because switching would discard queued changes. */
export const UNSENT_CHANGES_CODE = "UNSENT_CHANGES";

export type SwitchServerOptions = {
  /** What the person typed, or the default server's origin. */
  input: string;
  /** The server in use right now. */
  currentApiUrl: string;
  /** The server this build was made for. Its access is never released. */
  defaultApiUrl: string;
  permissions: PermissionsApi;
  /** Hand the validated origin to the worker. */
  send: (origin: string) => Promise<SetServerOutcome>;
};

export type SwitchServerResult =
  | { ok: true; origin: string }
  | {
      ok: false;
      /** Which step stopped it: the address, Chrome, or the worker. */
      stage: "input" | "access" | "server";
      code: string;
      message: string;
    };

/**
 * Run the switch.
 *
 * `async`, but the permission request happens before its first `await`, which
 * makes it part of the synchronous call — the test pins that.
 */
export async function switchServer({
  input,
  currentApiUrl,
  defaultApiUrl,
  permissions,
  send,
}: SwitchServerOptions): Promise<SwitchServerResult> {
  const parsed = normalizeServerInput(input);
  if (!parsed.ok) {
    return {
      ok: false,
      stage: "input",
      code: "INVALID_SERVER",
      message: parsed.message,
    };
  }
  const { origin } = parsed;

  // Nothing may be awaited above this line.
  const access = await requestServerAccess(origin, permissions);
  if (access === "refused") {
    return {
      ok: false,
      stage: "access",
      code: "SERVER_ACCESS_REFUSED",
      message: `Chrome did not give the extension access to ${serverHost(origin)}, so it cannot reach that server.`,
    };
  }

  const outcome = await send(origin);
  if (outcome.ok) return { ok: true, origin };

  // Compared as permission patterns, not as origins: `https://a.example` and
  // `https://a.example:8443` are two servers but ONE grant, and releasing the
  // failed one would take access away from the one in use.
  const inUse =
    sharesServerAccess(origin, currentApiUrl) ||
    sharesServerAccess(origin, defaultApiUrl);
  // A refusal over unsent changes is a question, not a verdict on the server:
  // the person is about to be asked, and answering yes retries with the same
  // host. Releasing here would put a second Chrome prompt behind that yes.
  if (!inUse && outcome.code !== UNSENT_CHANGES_CODE) {
    await releaseServerAccess(origin, permissions);
  }

  return {
    ok: false,
    stage: "server",
    code: outcome.code,
    message: outcome.message,
  };
}

/**
 * What a submit should do before anything is asked of Chrome.
 *
 * Synchronous for the same reason as {@link switchServer}: the picker calls it
 * inside the submit handler and, for `"switch"`, calls `switchServer` straight
 * after — still inside the gesture.
 */
export type SwitchPlan =
  | { kind: "invalid"; message: string }
  /** Queued changes would be discarded. Ask first; the confirm click switches. */
  | { kind: "confirm"; origin: string; pending: number }
  | { kind: "switch"; origin: string };

export function planServerSwitch(
  input: string,
  currentApiUrl: string,
  pendingSync: number,
): SwitchPlan {
  const parsed = normalizeServerInput(input);
  if (!parsed.ok) return { kind: "invalid", message: parsed.message };
  if (pendingSync > 0 && !sameServerOrigin(parsed.origin, currentApiUrl)) {
    return { kind: "confirm", origin: parsed.origin, pending: pendingSync };
  }
  return { kind: "switch", origin: parsed.origin };
}
