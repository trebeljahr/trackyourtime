import { useEffect, useRef, useState, type JSX } from "react";
import type { ClientKind, DeviceSession } from "@starter/core";
import type { Locale } from "@starter/shared";
import { formatRelativePast } from "../../i18n/format";
import { usePopupLocale, useT, type PopupT } from "../../i18n/use-t";
import { ConfirmPanel } from "../confirm-panel";

/**
 * Everything signed in as you, and the ways to sign one of them out.
 *
 * The list is fetched when the section is opened and after every successful
 * revoke — never by the three-second poll. Who is signed in does not have to
 * be right to the second, and putting `devices.list` on the snapshot's
 * critical path would cost a round trip every three seconds for a panel that
 * is closed almost always.
 *
 * The current session's row is deliberately NOT a revoke. Revoking it kills
 * the bearer token while the worker still holds a session record, so the popup
 * would keep rendering as signed in against a dead credential — so that row's
 * button runs the ordinary sign-out, which clears the record too. The worker
 * refuses a current session id as well, so a UI regression cannot reach the
 * server.
 */

export type DevicesSectionProps = {
  devices: DeviceSession[] | null;
  /** True when this session is shared with the web app, which changes what signing out does. */
  sharedSession: boolean;
  onList: () => Promise<boolean>;
  onRevoke: (id: string) => Promise<boolean>;
  onRevokeOthers: () => Promise<boolean>;
  onSignOut: () => Promise<boolean>;
};

type Confirm =
  | { kind: "device"; id: string; name: string }
  | { kind: "others" }
  | { kind: "self" };

export function devicesHint(devices: DeviceSession[] | null, t: PopupT): string {
  if (devices === null) return "…";
  return t("devices.hint", { count: devices.length });
}

/** "3 minutes ago" — sessions are short-lived enough that relative reads best. */
const formatRelative = (iso: string, t: PopupT, locale: Locale): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return t("devices.unknown");

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return t("devices.justNow");
  return formatRelativePast(seconds, locale);
};

/** The kind of client, said as a word rather than as its stored id. */
const clientLabel = (client: ClientKind, t: PopupT): string => {
  switch (client) {
    case "web":
      return t("devices.clients.web");
    case "desktop":
      return t("devices.clients.desktop");
    case "mobile":
      return t("devices.clients.mobile");
    case "raycast":
      return t("devices.clients.raycast");
    case "extension":
      return t("devices.clients.extension");
    case "cli":
      return t("devices.clients.cli");
    case "unknown":
      return t("devices.clients.unknown");
  }
};

export function DevicesSection({
  devices,
  sharedSession,
  onList,
  onRevoke,
  onRevokeOthers,
  onSignOut,
}: DevicesSectionProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  // Driven by the data, not by the mount. The worker drops this cache on
  // events the section never sees — a reconnecting sync socket, a foreign
  // `settings.changed` — and a one-shot mount fetch would then leave the
  // section on "Loading devices…" until it was collapsed and reopened. The ref
  // is only an in-flight guard, so the three-second poll cannot stack fetches.
  const inFlight = useRef(false);
  useEffect(() => {
    if (devices !== null || inFlight.current) return;
    inFlight.current = true;
    void onList().finally(() => {
      inFlight.current = false;
    });
  }, [devices, onList]);

  const run = async (action: () => Promise<boolean>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await action();
    setBusy(false);
    setConfirm(null);
  };

  if (devices === null) {
    return <p className="loading">{t("devices.loading")}</p>;
  }

  return (
    <>
      {devices.map((device) => {
        const open =
          confirm !== null &&
          ((confirm.kind === "device" && confirm.id === device.id) ||
            (confirm.kind === "self" && device.current));

        return (
          <div className="device" key={device.id} data-testid="device-row">
            <div className="device__text">
              <span className="device__name">
                {/* Built server-side by `describeClient`, so it is rendered
                    as-is rather than re-derived from the user agent here. */}
                {device.name}
                {device.clientVersion !== null ? (
                  <span className="device__hint" data-testid={`device-version-${device.id}`}>
                    {" "}
                    · {device.clientVersion}
                  </span>
                ) : null}
                {device.current ? (
                  <span className="device__badge">{t("devices.thisBrowser")}</span>
                ) : null}
              </span>
              <span className="device__hint">
                {t("devices.lastActive", {
                  client: clientLabel(device.client, t),
                  when: formatRelative(device.updatedAt, t, locale),
                })}
                {device.ipAddress !== null ? ` · ${device.ipAddress}` : ""}
              </span>
            </div>

            <button
              type="button"
              className="button device__action"
              disabled={busy}
              onClick={() =>
                setConfirm(
                  device.current
                    ? { kind: "self" }
                    : { kind: "device", id: device.id, name: device.name },
                )
              }
              data-testid={`device-revoke-${device.id}`}
            >
              {t("actions.signOut")}
            </button>

            {open ? (
              <ConfirmPanel
                title={
                  device.current
                    ? t("devices.signOutBrowserTitle")
                    : t("devices.signOutDeviceTitle")
                }
                hint={
                  device.current
                    ? sharedSession
                      ? t("devices.sharedSessionHint")
                      : t("devices.signOutBrowserHint")
                    : t("devices.signOutDeviceHint", { name: device.name })
                }
                confirmLabel={t("actions.signOut")}
                danger
                busy={busy}
                onCancel={() => setConfirm(null)}
                onConfirm={() => {
                  void run(() =>
                    device.current ? onSignOut() : onRevoke(device.id),
                  );
                }}
                testId="device-revoke-confirm"
              />
            ) : null}
          </div>
        );
      })}

      <button
        type="button"
        className="button button--danger button--block"
        // The caller's own session is always in the list, so one row means
        // there is nothing else to sign out.
        disabled={busy || devices.length <= 1}
        onClick={() => setConfirm({ kind: "others" })}
        data-testid="devices-revoke-others"
      >
        {t("devices.signOutOthers")}
      </button>

      {confirm !== null && confirm.kind === "others" ? (
        <ConfirmPanel
          title={t("devices.signOutOthersTitle")}
          hint={t("devices.signOutOthersHint")}
          confirmLabel={t("devices.signOutOthersConfirm")}
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void run(onRevokeOthers);
          }}
          testId="devices-revoke-others-confirm"
        />
      ) : null}
    </>
  );
}
