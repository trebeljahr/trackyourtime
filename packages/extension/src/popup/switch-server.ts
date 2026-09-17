/**
 * Switching the server the extension talks to, as plain functions.
 *
 * Kept out of the picker component so it can be tested without React or a
 * DOM. Two steps:
 *
 *   1. `normalizeServerInput` — synchronous, and stops a typo before anything
 *      is sent anywhere.
 *   2. The worker, which checks the server over the network (that it answers
 *      as Track Your Time, and trusts this extension's origin) and does the
 *      actual switch.
 *
 * There is no Chrome permission step. The extension holds no host access at
 * all: every request is a CORS request the server answers because it trusts
 * the extension's origin, so there is nothing to ask Chrome for and nothing to
 * give back when a server is refused.
 */
import {
  normalizeServerInput,
  sameServerOrigin,
  type ServerInputProblem,
} from "@starter/core";

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
  /** Hand the validated origin to the worker. */
  send: (origin: string) => Promise<SetServerOutcome>;
};

export type SwitchServerResult =
  | { ok: true; origin: string }
  | {
      ok: false;
      /** Which step stopped it: the address, or the worker. */
      stage: "input" | "server";
      code: string;
      message: string;
      /** What was wrong with the address, when `stage` is "input". */
      problem?: ServerInputProblem;
    };

/** Run the switch. */
export async function switchServer({
  input,
  send,
}: SwitchServerOptions): Promise<SwitchServerResult> {
  const parsed = normalizeServerInput(input);
  if (!parsed.ok) {
    return {
      ok: false,
      stage: "input",
      code: "INVALID_SERVER",
      message: parsed.message,
      problem: parsed.problem,
    };
  }
  const { origin } = parsed;

  const outcome = await send(origin);
  if (outcome.ok) return { ok: true, origin };
  return {
    ok: false,
    stage: "server",
    code: outcome.code,
    message: outcome.message,
  };
}

/** What a submit should do before anything is sent to the worker. */
export type SwitchPlan =
  | { kind: "invalid"; message: string; problem: ServerInputProblem }
  /** Queued changes would be discarded. Ask first; the confirm click switches. */
  | { kind: "confirm"; origin: string; pending: number }
  | { kind: "switch"; origin: string };

export function planServerSwitch(
  input: string,
  currentApiUrl: string,
  pendingSync: number,
): SwitchPlan {
  const parsed = normalizeServerInput(input);
  if (!parsed.ok) return { kind: "invalid", message: parsed.message, problem: parsed.problem };
  if (pendingSync > 0 && !sameServerOrigin(parsed.origin, currentApiUrl)) {
    return { kind: "confirm", origin: parsed.origin, pending: pendingSync };
  }
  return { kind: "switch", origin: parsed.origin };
}
