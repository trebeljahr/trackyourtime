import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { BackgroundState, SettingsPatch } from "../lib/messaging";
import { Header } from "./header";
import { Section } from "./accordion";
import { describeSync } from "./sync-label";
import type { SettingsSection } from "./route";
import { AccountSection, accountHint } from "./settings/account-section";
import { DevicesSection, devicesHint } from "./settings/devices-section";
import { GeneralSection, generalHint } from "./settings/general-section";
import { IdleSection, idleHint } from "./settings/idle-section";
import { LimitsSection, limitsHint } from "./settings/limits-section";
import type { SetServerOutcome } from "./switch-server";

/**
 * Everything the popup can change about the account, in one pushed screen.
 *
 * An accordion rather than a scroll: laid flat these six sections are about
 * 900px of controls inside a 560px window, which puts a currency picker far
 * enough down that its own dropdown clips and a FORBIDDEN raised by it renders
 * off-screen. Single-open keeps one section's worth of controls on screen at a
 * time, and closed headers carry their current value so reading a setting
 * costs nothing.
 *
 * There is no Save button anywhere. Every control writes one `settings.update`
 * carrying ONLY the field it owns — nested fields as a one-key block — because
 * the server does read-modify-write on those blocks and two racing whole-block
 * patches can silently lose one. Switches and selects commit on change;
 * numbers commit on blur and Enter.
 */

export type SettingsScreenProps = {
  state: BackgroundState;
  /** The last failure, already translated into human terms. */
  error: string | null;
  /** A one-line outcome carried in by the transition that landed here. */
  note?: string | null;
  /** Which section is open. Held on the route so a poll cannot collapse it. */
  section: SettingsSection | null;
  onOpenSection: (section: SettingsSection | null) => void;
  onBack: () => void;
  /** Where the idle strip sends the user: the prompt belongs next to the clock it changes. */
  onGoTracker: () => void;
  onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>;
  onListDevices: () => Promise<boolean>;
  onRevokeDevice: (id: string) => Promise<boolean>;
  onRevokeOtherDevices: () => Promise<boolean>;
  onSignOut: () => Promise<boolean>;
  onSetServer: (
    origin: string,
    discardUnsent: boolean,
  ) => Promise<SetServerOutcome>;
};

/** How long a section header says "Saved" after a successful write. */
const SAVED_FLASH_MS = 1600;

export function SettingsScreen({
  state,
  error,
  note = null,
  section,
  onOpenSection,
  onBack,
  onGoTracker,
  onUpdateSettings,
  onListDevices,
  onRevokeDevice,
  onRevokeOtherDevices,
  onSignOut,
  onSetServer,
}: SettingsScreenProps): JSX.Element {
  const [saved, setSaved] = useState<SettingsSection | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);

  useEffect(
    () => () => {
      if (flashRef.current !== null) clearTimeout(flashRef.current);
    },
    [],
  );

  // The banner is sticky under the header, but a screen scrolled halfway down
  // can still have it out of view when the message arrives — so it is brought
  // to the message rather than the other way round. Keyed on the text: a
  // second, different failure has to announce itself too.
  useEffect(() => {
    if (error === null) return;
    alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  /**
   * One write, attributed to the section that made it.
   *
   * The flash is set only on success, the same rule the server picker follows:
   * failure is the screen banner's job, and exactly one `role="alert"` region
   * per screen is what keeps a screen reader from announcing twice.
   */
  const saveFrom = useCallback(
    (id: SettingsSection) =>
      async (patch: SettingsPatch): Promise<boolean> => {
        const ok = await onUpdateSettings(patch);
        if (!ok) return false;
        if (flashRef.current !== null) clearTimeout(flashRef.current);
        setSaved(id);
        flashRef.current = setTimeout(() => setSaved(null), SAVED_FLASH_MS);
        return true;
      },
    [onUpdateSettings],
  );

  const toggle = (id: SettingsSection): void => {
    onOpenSection(section === id ? null : id);
  };

  /**
   * Escape leaves the screen, unless something nearer has already answered it.
   *
   * An open combobox, a field reverting itself and a ConfirmPanel all call
   * `preventDefault` on their way past, and a field's own revert-and-blur must
   * win over "go back" or a typo would cost the whole screen.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (target.getAttribute("role") === "combobox") return;
    event.preventDefault();
    onBack();
  };

  const sync = describeSync(
    state.syncStatus,
    state.serverReachable,
    state.pendingSync,
  );

  return (
    <div className="screen" onKeyDown={onKeyDown} data-testid="settings-screen">
      <Header title="Settings" onBack={onBack} sync={sync} />

      <div className="popup__body">
        <p
          ref={alertRef}
          className="notice screen__alert"
          role="alert"
          aria-live="assertive"
          data-testid="settings-error"
        >
          {error ?? ""}
        </p>

        {note !== null ? (
          <p className="notice notice--ok" role="status">
            {note}
          </p>
        ) : null}

        {/* The worker parks an idle question on whichever poll tick finds it,
            which can be mid-sentence in a settings field — so this never forces
            navigation. It is also only a strip: answering the prompt can stop,
            split or discard the running entry, and that answer belongs next to
            the clock it changes, not on top of a currency picker. */}
        {state.pendingIdle !== null ? (
          <button
            type="button"
            className="alert alert--idle"
            onClick={onGoTracker}
            data-testid="idle-alert"
          >
            Away for {Math.round(state.pendingIdle.idleSec / 60)} min — resolve
          </button>
        ) : null}

        <Section
          title="General"
          hint={generalHint(state.settings)}
          open={section === "general"}
          onToggle={() => toggle("general")}
          saved={saved === "general"}
          testId="settings-general"
        >
          <GeneralSection
            settings={state.settings}
            onSave={saveFrom("general")}
          />
        </Section>

        <hr className="rule" />

        <Section
          title="Idle"
          hint={idleHint(state.settings)}
          open={section === "idle"}
          onToggle={() => toggle("idle")}
          saved={saved === "idle"}
          testId="settings-idle"
        >
          <IdleSection settings={state.settings} onSave={saveFrom("idle")} />
        </Section>

        <hr className="rule" />

        <Section
          title="Limits"
          hint={limitsHint(state.settings)}
          open={section === "limits"}
          onToggle={() => toggle("limits")}
          saved={saved === "limits"}
          testId="settings-limits"
        >
          <LimitsSection settings={state.settings} onSave={saveFrom("limits")} />
        </Section>

        <hr className="rule" />

        <Section
          title="Devices"
          hint={devicesHint(state.devices)}
          open={section === "devices"}
          onToggle={() => toggle("devices")}
          saved={saved === "devices"}
          testId="settings-devices"
        >
          <DevicesSection
            devices={state.devices}
            sharedSession={state.sessionSource === "web"}
            onList={onListDevices}
            onRevoke={onRevokeDevice}
            onRevokeOthers={onRevokeOtherDevices}
            onSignOut={onSignOut}
          />
        </Section>

        <hr className="rule" />

        <Section
          title="Account"
          hint={accountHint(state.email)}
          open={section === "account"}
          onToggle={() => toggle("account")}
          saved={saved === "account"}
          testId="settings-account"
        >
          <AccountSection
            email={state.email}
            sessionSource={state.sessionSource}
            webUrl={state.webUrl}
            apiUrl={state.apiUrl}
            serverVersion={state.serverVersion}
            pendingSync={state.pendingSync}
            onSetServer={onSetServer}
            onSignOut={onSignOut}
          />
        </Section>
      </div>
    </div>
  );
}
