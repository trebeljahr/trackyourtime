"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { MIN_SERVER_API_LEVEL, SERVER_TOO_OLD } from "@starter/core";

import { useT } from "@/i18n/use-t";
import { SELF_HOSTING_UPGRADING_URL } from "@/lib/site-links";
import { useServerCompatibility } from "@/lib/server-level";

/**
 * The persistent banner when this app and its server cannot work together —
 * docs/versioning.md, principle 5: loud, and with a way out.
 *
 * Renders nothing in the prerendered HTML and on the hydrating render
 * (`useServerCompatibility` answers null for both), so it can never make the
 * served page and the hydrated tree disagree. No dismiss: the condition ends
 * when the server or the app is updated, and not before.
 */
export function VersionBanner(): React.JSX.Element | null {
  const t = useT("shell");
  const state = useServerCompatibility();
  if (state === null) return null;

  if (state.refusal === SERVER_TOO_OLD) {
    const level = String(state.level?.apiLevel ?? 0);
    const min = String(MIN_SERVER_API_LEVEL);
    const release = state.level?.release ?? null;
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm md:px-6"
        data-testid="version-banner"
        data-refusal={state.refusal}
      >
        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span>
          {release === null
            ? t("versionBanner.serverTooOldUnknownRelease", { level, min })
            : t("versionBanner.serverTooOld", { release, level, min })}
        </span>
        {/* Plain <a>: the docs are not a Next route (CLAUDE.md, docs site). */}
        <a
          href={SELF_HOSTING_UPGRADING_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary underline-offset-4 hover:underline"
          data-testid="version-banner-link"
        >
          {t("versionBanner.howToUpdate")}
        </a>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm md:px-6"
      data-testid="version-banner"
      data-refusal={state.refusal}
    >
      <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
      <span>{t("versionBanner.clientTooOld")}</span>
    </div>
  );
}
