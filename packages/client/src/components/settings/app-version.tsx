"use client";

import * as React from "react";
import { API_LEVEL } from "@starter/shared";

import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useT } from "@/i18n/use-t";
import { APP_VERSION, BUILD_ID } from "@/lib/app-version";
import { isCapacitor } from "@/lib/shell";
import { useServerSupports } from "@/lib/server-level";
import { SELF_HOSTING_URL } from "@/lib/site-links";
import { trpc } from "@/lib/trpc";

/**
 * Which release this app is, and which the server is.
 *
 * The first thing a bug report or a self-hoster's "does this app work with my
 * server?" needs. The app's own half is a build-time constant, so it renders
 * identically in the prerendered HTML; the server's half arrives after mount.
 *
 * An owner or admin of a server that runs the opt-in update check also sees
 * "vX.Y.Z is available", with the release notes and the Upgrading guide. The
 * server decides and answers null for everybody else; the role only saves the
 * request. Nothing here updates anything.
 */
export function AppVersionInfo(): React.JSX.Element {
  const t = useT("settings");
  const [nativeBuild, setNativeBuild] = React.useState("");
  React.useEffect(() => {
    if (!isCapacitor()) return;
    let active = true;
    void import("@capacitor/app")
      .then(({ App }) => App.getInfo())
      .then((info) => {
        if (active) setNativeBuild(info.build);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const health = trpc.health.check.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const server = health.data;
  const { workspace } = useActiveWorkspace();
  const serverHasNotice = useServerSupports("settings.updateNotice");
  const mayUpgrade =
    serverHasNotice && (workspace?.role === "owner" || workspace?.role === "admin");
  const notice = trpc.settings.updateNotice.useQuery(undefined, {
    enabled: mayUpgrade,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const update = mayUpgrade ? notice.data ?? null : null;
  const serverVersion = server
    ? [server.release, server.commit ? `(${server.commit.slice(0, 7)})` : ""]
        .filter((part) => part !== "")
        .join(" ")
    : "";
  const clientVersion = `${APP_VERSION}${nativeBuild ? ` · build ${nativeBuild}` : ""}${BUILD_ID ? ` (${BUILD_ID})` : ""}`;

  return (
    <div
      className="space-y-0.5 text-center text-xs text-muted-foreground"
      data-testid="settings-app-version"
    >
      <p>
        <span data-testid="app-version">
          {APP_VERSION
            ? t("about.appVersion", { version: clientVersion })
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
      {update ? (
        <p data-testid="update-notice">
          {t("about.updateAvailable", { version: update.version })}{" "}
          <a
            className="underline underline-offset-2"
            href={update.releaseNotesUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("about.releaseNotes")}
          </a>
          {" · "}
          <a
            className="underline underline-offset-2"
            href={`${SELF_HOSTING_URL}#upgrading`}
            target="_blank"
            rel="noreferrer"
          >
            {t("about.upgrading")}
          </a>
        </p>
      ) : null}
    </div>
  );
}
