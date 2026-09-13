import { useEffect, useRef, useState, type JSX } from "react";
import type { DeviceSession } from "@starter/core";
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

export function devicesHint(devices: DeviceSession[] | null): string {
  if (devices === null) return "…";
  return devices.length === 1 ? "1 signed in" : `${devices.length} signed in`;
}

/** "3 minutes ago" — sessions are short-lived enough that relative reads best. */
const formatRelative = (iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";

  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["month", 2_592_000],
    ["year", 31_536_000],
  ];

  // Largest unit that fits, walked from the top. Comparing against a multiple
  // of the candidate's own size instead would let "hour" run to 60 hours, and
  // a device last seen two days ago would read "50 hours ago".
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let divisor = 60;
  for (const [candidate, size] of [...units].reverse()) {
    if (seconds < size) continue;
    unit = candidate;
    divisor = size;
    break;
  }

  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    -Math.round(seconds / divisor),
    unit,
  );
};

const SHARED_SESSION_HINT =
  "This session is shared with the web app, so signing out here signs out " +
  "Track Your Time in this browser too.";

export function DevicesSection({
  devices,
  sharedSession,
  onList,
  onRevoke,
  onRevokeOthers,
  onSignOut,
}: DevicesSectionProps): JSX.Element {
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
    return <p className="loading">Loading devices…</p>;
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
                {device.current ? (
                  <span className="device__badge">This browser</span>
                ) : null}
              </span>
              <span className="device__hint">
                {device.client} · Last active {formatRelative(device.updatedAt)}
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
              Sign out
            </button>

            {open ? (
              <ConfirmPanel
                title={
                  device.current
                    ? "Sign this browser out?"
                    : "Sign this device out?"
                }
                hint={
                  device.current
                    ? sharedSession
                      ? SHARED_SESSION_HINT
                      : "The extension forgets its session and you sign in again."
                    : `${device.name} stops syncing immediately and has to sign in again. Nothing it already tracked is lost.`
                }
                confirmLabel="Sign out"
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
        Sign out other devices
      </button>

      {confirm !== null && confirm.kind === "others" ? (
        <ConfirmPanel
          title="Sign every other device out?"
          hint="This browser stays signed in. Everything else has to sign in again."
          confirmLabel="Sign them out"
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
