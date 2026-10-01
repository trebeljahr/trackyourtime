"use client";

import { FIREFOX_EXTENSION_ID } from "@starter/shared/extension-relay";
import * as React from "react";
import { EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS } from "@starter/shared";

import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { isAppShell } from "@/lib/shell";
import { useSession } from "@/lib/auth-client";
import { approveDeviceCode } from "@/lib/device-approve";
import {
  createExtensionBridgeController,
  type BridgeSessionState,
  type ExtensionBridgeController,
} from "@/lib/extension-bridge";
import {
  chromeRuntime,
  pageRelayAvailable,
  extensionIds,
  sendToExtension,
} from "@/lib/extension-bridge-transport";

type SessionLike = {
  data: { user?: { id?: unknown; email?: unknown; image?: unknown } | null; session?: { createdAt?: unknown } | null } | null;
  isPending: boolean;
  error: unknown;
};

/** better-auth's session hook, reduced to what the bridge may send. */
export const bridgeSessionState = (result: SessionLike): BridgeSessionState => {
  if (result.isPending) return { status: "pending" };
  if (result.error !== null && result.error !== undefined) return { status: "error" };
  const userId = result.data?.user?.id;
  if (typeof userId !== "string" || userId === "") {
    return { status: "resolved", session: null };
  }
  const raw = result.data?.session?.createdAt;
  const createdAt =
    raw instanceof Date || typeof raw === "string" || typeof raw === "number"
      ? new Date(raw).getTime()
      : Number.NaN;
  // Confirmation must refer to a known web session.
  if (!Number.isFinite(createdAt)) return { status: "error" };
  const email = result.data?.user?.email;
  const image = result.data?.user?.image;
  return { status: "resolved", session: {
    userId, createdAt,
    ...(typeof email === "string" && email !== "" ? {
      profile: { email, image: typeof image === "string" && /^https?:\/\//.test(image) ? image : null },
    } : {}),
  } };
};

/**
 * Whether this document is the tab's top-level one. A frame — which any site
 * can make of the web app — must not publish account offers.
 */
export const isTopLevelDocument = (win: Window): boolean => {
  try {
    return win.top === win.self;
  } catch {
    // Reading a cross-origin `top` can throw in older engines: a frame.
    return false;
  }
};

/** The top-level web app with a Chrome runtime or the hosted Firefox relay. */
const bridgeAvailable = (): boolean =>
  typeof window !== "undefined" &&
  !isAppShell() &&
  isTopLevelDocument(window) &&
  /^https?:$/.test(window.location.protocol) &&
  (chromeRuntime() !== null || pageRelayAvailable());

/**
 * Offers this web account to the extension for explicit confirmation — see
 * `lib/extension-bridge.ts`.
 *
 * Renders nothing and decides everything in effects: the prerendered HTML is
 * the same on every host, and nothing runs before hydration. Inert in
 * Capacitor and Electron, and in every browser where no extension
 * connects to this origin. Mounted once, inside `AuthProvider`.
 */
export function ExtensionBridge(): null {
  const session = useSession();
  const controllerRef = React.useRef<ExtensionBridgeController | null>(null);

  React.useEffect(() => {
    if (!bridgeAvailable()) return;
    const ids = chromeRuntime() === null && pageRelayAvailable() ? [FIREFOX_EXTENSION_ID] : extensionIds();
    if (ids.length === 0) return;

    const controller = createExtensionBridgeController({
      enabled: bridgeAvailable,
      ids: () => ids,
      apiOrigin: getAbsoluteApiOrigin,
      send: (id, message) => sendToExtension(id, message),
      approve: async (userCode) =>
        (await approveDeviceCode(userCode, { alreadyApprovedIsOk: true })).ok,
      now: () => Date.now(),
      onOutcomes:
        process.env.NODE_ENV === "development"
          ? (outcomes) => console.debug("[extension-bridge]", outcomes)
          : undefined,
    });
    controllerRef.current = controller;

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") controller.wake();
    };
    const onFocus = (): void => controller.wake();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    // The popup cannot message a web page. Poll while mounted so a confirmed
    // account can approve its device code without another focus transition.
    const timer = window.setInterval(() => controller.wake(), EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const state = bridgeSessionState(session);
  const stateKey =
    state.status === "resolved"
      ? `resolved:${state.session?.userId ?? ""}:${state.session?.createdAt ?? ""}:${state.session?.profile?.email ?? ""}:${state.session?.profile?.image ?? ""}`
      : state.status;

  React.useEffect(() => {
    // Declared after the setup effect, so on mount the controller exists by
    // the time this runs. Keyed on a string so a re-render with an equal
    // session is not a new update.
    controllerRef.current?.update(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

  return null;
}
