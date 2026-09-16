/**
 * The words for "one side is too old for the other", kept free of Raycast
 * imports so they can be read (and tested) without a Raycast runtime.
 *
 * Raycast stays English. docs/versioning.md → "Principles" rule 5: a refusal
 * names which side is too old and what to update, never a generic error.
 */
import {
  CLIENT_TOO_OLD,
  MIN_SERVER_API_LEVEL,
  SELF_HOSTING_UPGRADING_URL,
  SERVER_TOO_OLD,
  type ServerLevel,
  type VersionRefusal,
} from "@starter/core";

export type CompatibilityBanner = {
  /** Short enough for a list row or a menu bar item. */
  title: string;
  /** The whole explanation, including what to do. */
  message: string;
  /** Where the way out is documented, or null when there is no page for it. */
  url: string | null;
};

/**
 * The banner for a refusal, or null when this build and the server agree (or
 * nothing is known yet — an unknown server is never reported as a problem).
 */
export const compatibilityBanner = (
  refusal: VersionRefusal | null,
  level: Pick<ServerLevel, "apiLevel" | "release"> | null,
  minServerApiLevel: number = MIN_SERVER_API_LEVEL,
): CompatibilityBanner | null => {
  switch (refusal) {
    case SERVER_TOO_OLD: {
      const apiLevel = level?.apiLevel ?? 0;
      const runs = level?.release
        ? `This server runs v${level.release} (API level ${apiLevel}).`
        : `This server reports API level ${apiLevel}.`;
      return {
        title: "This server is too old for this app",
        message: `${runs} This app needs level ${minServerApiLevel} or higher. Ask your server admin to update.`,
        url: SELF_HOSTING_UPGRADING_URL,
      };
    }
    case CLIENT_TOO_OLD:
      // No Raycast Store URL constant exists; Raycast updates store
      // extensions itself, so there is no page to send anyone to.
      return {
        title: "This app is too old for this server",
        message: "This app is too old for this server. Update the app.",
        url: null,
      };
    case null:
      return null;
  }
};
