import { useState, type FormEvent, type JSX } from "react";
import { sameServerOrigin } from "@starter/core";
import { DEFAULT_API_URL } from "../lib/config";
import { defaultServerLabel, describeServer } from "../lib/server-label";
import { ConfirmPanel } from "./confirm-panel";
import {
  planServerSwitch,
  switchServer,
  UNSENT_CHANGES_CODE,
  type SetServerOutcome,
} from "./switch-server";

export type ServerPickerProps = {
  /** The server in use. */
  apiUrl: string;
  /** Queued changes a switch would discard, from the snapshot. */
  pendingSync: number;
  /** Send `config:set-server`; the snapshot it returns is applied by the caller. */
  onSetServer: (
    origin: string,
    discardUnsent: boolean,
  ) => Promise<SetServerOutcome>;
  /** Called once the worker has switched, so the caller can fold the picker away. */
  onSwitched?: () => void;
};

type Choice = "default" | "custom";

/** A switch waiting on "yes, discard them". */
type PendingConfirm = { origin: string; hint: string };

const unsentHint = (pending: number, apiUrl: string): string =>
  `${pending} change${pending === 1 ? " has" : "s have"} not reached ${describeServer(apiUrl, DEFAULT_API_URL)} yet. Switching servers signs you out, and the extension discards ${pending === 1 ? "it" : "them"}.`;

/**
 * Choose which Track Your Time server the extension talks to.
 *
 * Two choices rather than one URL field, because most people use the hosted
 * service and should never have to know its API address. "My own server"
 * opens the field. In a development build the first choice is named by its
 * host, since calling a laptop "cloud" would be false.
 *
 * The submit handler is where Chrome's permission prompt comes from, so it
 * must not `await` anything before `switchServer` has asked — see
 * `switch-server.ts`. The confirm panel's button is a click of its own, which
 * is why a switch that needs confirming can still ask Chrome from there.
 *
 * Reachable from the signed-out screen as well as Settings → Account: a person
 * who cannot reach their server has to change it BEFORE a sign-in can work.
 */
export function ServerPicker({
  apiUrl,
  pendingSync,
  onSetServer,
  onSwitched,
}: ServerPickerProps): JSX.Element {
  const usingDefault = sameServerOrigin(apiUrl, DEFAULT_API_URL);
  const [choice, setChoice] = useState<Choice>(
    usingDefault ? "default" : "custom",
  );
  const [draft, setDraft] = useState(usingDefault ? "" : apiUrl);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  /**
   * Switch to `origin`. Called straight from a click — the submit or the
   * confirm — with nothing awaited first.
   */
  const run = (origin: string, discardUnsent: boolean): void => {
    setBusy(true);
    setProblem(null);
    void switchServer({
      input: origin,
      currentApiUrl: apiUrl,
      defaultApiUrl: DEFAULT_API_URL,
      permissions: chrome.permissions,
      send: (validated) => onSetServer(validated, discardUnsent),
    }).then((result) => {
      setBusy(false);
      if (result.ok) {
        setConfirm(null);
        onSwitched?.();
        return;
      }
      // The snapshot's count was a poll behind and the worker found queued
      // work after all. Ask now, with the worker's own sentence.
      if (result.code === UNSENT_CHANGES_CODE && !discardUnsent) {
        setConfirm({ origin, hint: result.message });
        return;
      }
      setConfirm(null);
      setProblem(result.message);
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    const input = choice === "default" ? DEFAULT_API_URL : draft;
    const plan = planServerSwitch(input, apiUrl, pendingSync);
    if (plan.kind === "invalid") {
      setProblem(plan.message);
      return;
    }
    if (plan.kind === "confirm") {
      setProblem(null);
      setConfirm({ origin: plan.origin, hint: unsentHint(plan.pending, apiUrl) });
      return;
    }
    run(plan.origin, false);
  };

  if (confirm !== null) {
    return (
      <ConfirmPanel
        title={`Switch to ${describeServer(confirm.origin, DEFAULT_API_URL)}?`}
        hint={confirm.hint}
        confirmLabel="Discard and switch"
        danger
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (busy) return;
          run(confirm.origin, true);
        }}
        testId="server-switch-confirm"
      />
    );
  }

  return (
    <form className="form" onSubmit={submit} data-testid="server-picker">
      <fieldset className="choices">
        <legend className="field__label">Server</legend>

        <label className="choice">
          <input
            type="radio"
            name="server-choice"
            checked={choice === "default"}
            onChange={() => {
              setChoice("default");
              setProblem(null);
            }}
            data-testid="server-choice-default"
          />
          <span>{defaultServerLabel(DEFAULT_API_URL)}</span>
        </label>

        <label className="choice">
          <input
            type="radio"
            name="server-choice"
            checked={choice === "custom"}
            onChange={() => {
              setChoice("custom");
              setProblem(null);
            }}
            data-testid="server-choice-custom"
          />
          <span>My own server</span>
        </label>
      </fieldset>

      {/* Always rendered, never disabled: typing an address IS choosing "my
          own server", so the field selects it rather than waiting to be
          unlocked by the radio above. */}
      <div className="field">
        <label className="field__label" htmlFor="server-url">
          Server address
        </label>
        <input
          id="server-url"
          className="input"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://track.example.com"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setChoice("custom");
            setProblem(null);
          }}
          data-testid="api-url-input"
        />
      </div>

      <button
        className="button"
        type="submit"
        disabled={busy || (choice === "custom" && draft.trim() === "")}
        data-testid="api-url-save"
      >
        {busy ? "Checking server…" : "Use this server"}
      </button>

      <p className="notice" role="alert" aria-live="assertive" data-testid="server-picker-error">
        {problem ?? ""}
      </p>
    </form>
  );
}
