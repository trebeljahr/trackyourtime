"use client";

import * as React from "react";
import { API_LEVEL } from "@starter/shared";

import { useT } from "@/i18n/use-t";
import { APP_VERSION } from "@/lib/app-version";
import { trpc } from "@/lib/trpc";

/**
 * Which release this app is, and which the server is.
 *
 * The first thing a bug report or a self-hoster's "does this app work with my
 * server?" needs. The app's own half is a build-time constant, so it renders
 * identically in the prerendered HTML; the server's half arrives after mount.
 */
export function AppVersionInfo(): React.JSX.Element {
  const t = useT("settings");
  const health = trpc.health.check.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const server = health.data;
  const serverVersion = server
    ? [server.release, server.commit ? `(${server.commit.slice(0, 7)})` : ""]
        .filter((part) => part !== "")
        .join(" ")
    : "";

  return (
    <div
      className="space-y-0.5 text-center text-xs text-muted-foreground"
      data-testid="settings-app-version"
    >
      <p>
        <span data-testid="app-version">
          {APP_VERSION
            ? t("about.appVersion", { version: APP_VERSION })
            : t("about.appVersionUnknown")}
        </span>
        {" · "}
        {t("about.apiLevel", { level: String(API_LEVEL) })}
      </p>
      {server ? (
        <p data-testid="server-version">
          {serverVersion !== ""
            ? t("about.server", { version: serverVersion, level: String(server.apiLevel) })
            : t("about.serverUnknown")}
        </p>
      ) : null}
    </div>
  );
}
