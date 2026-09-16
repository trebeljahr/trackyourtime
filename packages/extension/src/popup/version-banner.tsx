import type { JSX } from "react";
import { CLIENT_TOO_OLD, SELF_HOSTING_UPGRADING_URL, SERVER_TOO_OLD } from "@starter/core";
import type { PopupT } from "../i18n/use-t";
import type { ServerCompatibility } from "../lib/messaging";

export type VersionBannerProps = {
  compatibility: ServerCompatibility;
  t: PopupT;
};

/**
 * This build and the server in use do not fit, said once above every screen.
 *
 * Rendered from the worker's snapshot only — the popup has no snapshot before
 * its first answer, so the banner can never flash on a pre-render. It names
 * which side is too old and what to update (docs/versioning.md, "Fail loudly,
 * with a way out"), instead of letting every request fail like a dead network.
 */
export function VersionBanner({ compatibility, t }: VersionBannerProps): JSX.Element | null {
  const { refusal, release, apiLevel, minServerApiLevel } = compatibility;

  if (refusal === CLIENT_TOO_OLD) {
    return (
      <div className="notice access" role="alert" data-testid="version-banner" data-refusal={refusal}>
        <p className="access__text">{t("version.clientTooOld")}</p>
      </div>
    );
  }

  if (refusal !== SERVER_TOO_OLD) return null;

  const level = String(apiLevel ?? 0);
  const min = String(minServerApiLevel);
  return (
    <div className="notice access" role="alert" data-testid="version-banner" data-refusal={refusal}>
      <p className="access__text">
        {release === null
          ? t("version.serverTooOldNoRelease", { level, min })
          : t("version.serverTooOld", { release, level, min })}
      </p>
      <a
        href={SELF_HOSTING_UPGRADING_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="version-banner-upgrade"
      >
        {t("version.howToUpdate")}
      </a>
    </div>
  );
}
