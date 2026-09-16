"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Server } from "lucide-react";
import {
  CLOUD_API_ORIGIN,
  CLOUD_SERVER_LABEL,
  CLIENT_TOO_OLD,
  checkServer,
  describeServerVersion,
  MIN_SERVER_API_LEVEL,
  serverCompatibility,
  SERVER_TOO_OLD,
  normalizeServerInput,
  sameServerOrigin,
  serverHost,
  serverLabel,
  type ServerInfo,
} from "@starter/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApiOrigin } from "@/hooks/use-api-origin";
import { useIsNative } from "@/hooks/use-is-native";
import { getApiOrigin, getDefaultApiOrigin } from "@/lib/api-origin";
import { refreshPendingCount } from "@/lib/offline";
import { getServerLevelCache } from "@/lib/server-level";
import { switchServer } from "@/lib/server-switch";
import { serverCheckMessage, serverInputMessage } from "@/lib/server-problem-message";
import { useT } from "@/i18n/use-t";
import type { Translator } from "@/i18n/translator";

/**
 * Which server the phone app signs in to.
 *
 * Renders NOTHING on web, and nothing on the first client render anywhere —
 * `useIsNative` hydrates as the web tree — so the login page served to a
 * browser is exactly the page it was. The web app talks to the server it was
 * built for; only a store-installed phone app has a choice to make.
 *
 * The choice is checked before it is saved: the address has to parse, plain
 * http is refused off this device, the server has to answer as Track Your Time
 * with its database up, and it has to trust this app's origin — otherwise
 * sign-in would fail a moment later with a bare `403 INVALID_ORIGIN` that
 * nobody on a phone can diagnose.
 */

type Mode = "default" | "own";

/** The build's own server, named — "cloud" only when it really is the cloud. */
const defaultLabel = (origin: string, t: Translator<"shell">): string =>
  sameServerOrigin(origin, CLOUD_API_ORIGIN)
    ? CLOUD_SERVER_LABEL
    : t("serverPicker.defaultServer", { host: serverHost(origin) });

/** Why a reachable server still cannot be used from this app. */
export const untrustedMessage = (server: ServerInfo, t: Translator<"shell">): string =>
  t("serverPicker.untrusted", { host: serverHost(server.origin) });

/**
 * Why a reachable, trusted server still cannot be used by this build, or null.
 * Checked beside `originTrusted`: signing in to a server this app cannot talk
 * to would only move the failure to every request after it.
 */
export const incompatibleMessage = (
  server: ServerInfo,
  t: Translator<"shell">,
): string | null => {
  const refusal = serverCompatibility(server);
  const host = serverHost(server.origin);
  if (refusal === SERVER_TOO_OLD) {
    return t("serverPicker.serverTooOld", {
      host,
      level: String(server.apiLevel),
      min: String(MIN_SERVER_API_LEVEL),
    });
  }
  if (refusal === CLIENT_TOO_OLD) return t("serverPicker.appTooOld", { host });
  return null;
};

export function NativeServerPicker(): React.JSX.Element | null {
  const native = useIsNative();
  const { choice, ready } = useApiOrigin();

  if (!native) return null;
  // Remounted once the stored choice arrives, so the form opens on it rather
  // than on the default it rendered while Preferences was being read.
  return (
    <ServerPickerBody
      key={ready ? (choice?.origin ?? "default") : "loading"}
      chosen={choice?.origin ?? null}
      ready={ready}
    />
  );
}

function ServerPickerBody({
  chosen,
  ready,
}: {
  chosen: string | null;
  ready: boolean;
}): React.JSX.Element {
  const t = useT("shell");
  const tc = useT("common");
  const fallback = getDefaultApiOrigin();
  const current = getApiOrigin();
  const usingDefault = chosen === null || sameServerOrigin(chosen, fallback);

  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>(usingDefault ? "default" : "own");
  const [address, setAddress] = React.useState(usingDefault ? "" : (chosen ?? ""));
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [found, setFound] = React.useState<ServerInfo | null>(null);
  const [pending, setPending] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    void refreshPendingCount().then(setPending);
  }, [open]);

  const choose = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFound(null);

    let origin = fallback;
    if (mode === "own") {
      const parsed = normalizeServerInput(address);
      if (!parsed.ok) {
        setError(serverInputMessage(parsed, address, t));
        return;
      }
      origin = parsed.origin;
    }

    setChecking(true);
    try {
      const result = await checkServer(origin);
      if (!result.ok) {
        setError(serverCheckMessage(result, origin, t));
        return;
      }
      if (result.server.originTrusted === false) {
        setError(untrustedMessage(result.server, t));
        return;
      }
      const incompatible = incompatibleMessage(result.server, t);
      if (incompatible !== null) {
        setError(incompatible);
        return;
      }
      // What the server just said is the level cache's first answer about it;
      // the app start after the switch's reload asks again.
      getServerLevelCache().record({
        origin: result.server.origin,
        apiLevel: result.server.apiLevel,
        minClientApiLevel: result.server.minClientApiLevel,
        release: result.server.release,
      });
      setFound(result.server);
      await switchServer(
        sameServerOrigin(origin, fallback)
          ? null
          : {
              origin,
              webUrl: result.server.webUrl,
              release: result.server.release,
            },
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="rounded-md border border-border p-3 text-sm"
      data-testid="server-picker"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {t.rich("serverPicker.current", {
              label: ready ? serverLabel(current) : "…",
              current: (chunks) => (
                <span className="font-medium" data-testid="server-picker-current">
                  {chunks}
                </span>
              ),
            })}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((value) => !value)}
          // Not before the stored choice is known: the form opens on it.
          disabled={!ready}
          aria-expanded={open}
          data-testid="server-picker-toggle"
        >
          {open ? tc("actions.close") : tc("actions.change")}
        </Button>
      </div>

      {open ? (
        <form className="mt-3 space-y-3" onSubmit={(event) => void choose(event)}>
          <div role="radiogroup" aria-label={t("serverPicker.groupLabel")} className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="server-mode"
                checked={mode === "default"}
                onChange={() => setMode("default")}
                data-testid="server-picker-default"
              />
              {defaultLabel(fallback, t)}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="server-mode"
                checked={mode === "own"}
                onChange={() => setMode("own")}
                data-testid="server-picker-own"
              />
              {t("serverPicker.ownServer")}
            </label>
          </div>

          {mode === "own" ? (
            <Input
              // Text, not url: a type="url" field refuses "track.example.com"
              // before submit, and a missing https:// is exactly what
              // normalizeServerInput is there to forgive.
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://track.example.com"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setError(null);
              }}
              aria-label={t("serverPicker.address")}
              data-testid="server-picker-address"
            />
          ) : null}

          {pending > 0 ? (
            <p className="text-muted-foreground" data-testid="server-picker-pending">
              {t("serverPicker.pending", { count: pending, server: serverLabel(current) })}
            </p>
          ) : null}

          {error ? (
            <p className="text-destructive" role="alert" data-testid="server-picker-error">
              {error}
            </p>
          ) : null}
          {found ? (
            <p className="text-muted-foreground" role="status" data-testid="server-picker-found">
              {t("serverPicker.found", {
                version: describeServerVersion(found),
                host: serverHost(found.origin),
              })}
            </p>
          ) : null}

          <Button
            type="submit"
            size="sm"
            disabled={checking || (mode === "own" && address.trim() === "")}
            data-testid="server-picker-save"
          >
            {checking ? <Loader2 className="size-4 animate-spin" /> : null}
            {checking ? t("serverPicker.checking") : t("serverPicker.use")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The server named on the sign-up screen, on native only — an account is
 * created on one specific server, and on a phone that is a choice the person
 * made, so it is said before they give it their email.
 */
export function NativeServerNote(): React.JSX.Element | null {
  const native = useIsNative();
  const { ready } = useApiOrigin();
  const t = useT("shell");
  if (!native) return null;
  return (
    <p className="text-center text-sm text-muted-foreground" data-testid="server-note">
      {t.rich("serverPicker.creatingOn", {
        label: ready ? serverLabel(getApiOrigin()) : "…",
        server: (chunks) => <span className="font-medium">{chunks}</span>,
      })}{" "}
      <Link href="/login" className="text-primary hover:underline">
        {t("serverPicker.change")}
      </Link>
    </p>
  );
}
