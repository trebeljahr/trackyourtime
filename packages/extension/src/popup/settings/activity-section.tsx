import { useState, type JSX } from "react";
import type { ActivitySettings, ActivitySnapshot } from "../../lib/messaging";
import { SettingRow } from "../accordion";
import { ConfirmPanel } from "../confirm-panel";
import { NumberField } from "../number-field";
import { Switch } from "../switch";
import { useT, type PopupT } from "../../i18n/use-t";

/**
 * Settings → Activity: whether this browser watches which sites you use.
 *
 * Off by default. Turning it on asks Chrome for the optional `tabs` permission
 * from the same click — `chrome.permissions.request` only works inside a user
 * gesture, which is why the request is made here in the popup and not by the
 * worker. Everything in this section is about this device alone; none of it
 * is a synced setting, and nothing captured is sent anywhere until a
 * suggestion is accepted.
 */

export type ActivitySectionProps = {
  activity: ActivitySnapshot;
  onSave: (patch: Partial<ActivitySettings>) => Promise<boolean>;
  /** Ask Chrome for the permission; resolves whether it was granted. */
  onRequestPermission: () => Promise<boolean>;
  onWipe: () => Promise<boolean>;
};

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;

export function activityHint(activity: ActivitySnapshot, t: PopupT): string {
  return activity.settings.enabled && activity.permitted ? t("settings.on") : t("settings.off");
}

export function ActivitySection({
  activity,
  onSave,
  onRequestPermission,
  onWipe,
}: ActivitySectionProps): JSX.Element {
  const t = useT("popup");
  const { settings } = activity;
  const [host, setHost] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const on = settings.enabled && activity.permitted;

  const addHost = (): void => {
    const next = host.trim();
    if (next === "") return;
    void onSave({ excludedHosts: [...settings.excludedHosts, next] }).then((ok) => {
      if (ok) setHost("");
    });
  };

  return (
    <>
      <SettingRow
        note={t("activity.enabledNote")}
        testId="setting-activity-enabled"
      >
        <Switch
          checked={on}
          onChange={(enabled) => {
            if (!enabled) {
              void onSave({ enabled: false });
              return;
            }
            // First, before anything else is awaited: Chrome only shows the
            // permission prompt inside the click that asked for it.
            void onRequestPermission().then((granted) => {
              if (granted) void onSave({ enabled: true });
            });
          }}
          label={on ? t("activity.on") : t("activity.off")}
          testId="activity-enabled"
        />
      </SettingRow>

      <SettingRow
        note={t("activity.titlesNote")}
        testId="setting-activity-titles"
      >
        <Switch
          checked={settings.storeTitles}
          onChange={(storeTitles) => {
            void onSave({ storeTitles });
          }}
          label={settings.storeTitles ? t("activity.storingTitles") : t("activity.hostnamesOnly")}
          disabled={!on}
          testId="activity-titles"
        />
      </SettingRow>

      <SettingRow
        label={t("activity.exclude")}
        htmlFor="setting-activity-exclude"
        note={t("activity.excludeNote")}
        testId="setting-activity-excluded"
      >
        {settings.excludedHosts.map((pattern) => (
          <div className="device" key={pattern} data-testid="activity-excluded-host">
            <div className="device__text">
              <span className="device__name">{pattern}</span>
            </div>
            <button
              type="button"
              className="button device__action"
              onClick={() => {
                void onSave({
                  excludedHosts: settings.excludedHosts.filter((it) => it !== pattern),
                });
              }}
              data-testid={`activity-excluded-remove-${pattern}`}
            >
              {t("activity.remove")}
            </button>
          </div>
        ))}
        <div className="activity__add">
          <input
            id="setting-activity-exclude"
            className="input"
            value={host}
            placeholder="bank.example.com"
            onChange={(event) => setHost(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addHost();
              }
            }}
            data-testid="activity-exclude-input"
          />
          <button
            type="button"
            className="button"
            disabled={host.trim() === ""}
            onClick={addHost}
            data-testid="activity-exclude-add"
          >
            {t("activity.add")}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={t("activity.retention")}
        htmlFor="setting-activity-retention"
        note={t("activity.retentionNote")}
        testId="setting-activity-retention"
      >
        <NumberField
          id="setting-activity-retention"
          value={settings.retentionDays}
          onCommit={(retentionDays) => {
            void onSave({ retentionDays });
          }}
          min={MIN_RETENTION_DAYS}
          max={MAX_RETENTION_DAYS}
          suffix={t("activity.retentionSuffix")}
          ariaLabel={t("activity.retentionLabel")}
          testId="activity-retention"
        />
      </SettingRow>

      <SettingRow
        note={
          activity.storedSegments === null
            ? t("activity.wipeNote")
            : t("activity.wipeNoteCount", { count: activity.storedSegments })
        }
        testId="setting-activity-wipe"
      >
        <button
          type="button"
          className="button button--danger button--block"
          disabled={busy}
          onClick={() => setConfirming(true)}
          data-testid="activity-wipe"
        >
          {t("activity.wipe")}
        </button>
        {confirming ? (
          <ConfirmPanel
            title={t("activity.wipeTitle")}
            hint={t("activity.wipeHint")}
            confirmLabel={t("actions.delete")}
            danger
            busy={busy}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setBusy(true);
              void onWipe().finally(() => {
                setBusy(false);
                setConfirming(false);
              });
            }}
            testId="activity-wipe-confirm"
          />
        ) : null}
      </SettingRow>
    </>
  );
}
