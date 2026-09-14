import { serverHost, type ParsedServerInput, type ServerCheck } from "@starter/core";

import type { Translator } from "@/i18n/translator";

/**
 * A refused server address, in the reader's language.
 *
 * `@starter/core` explains every refusal in English, which is right for
 * Raycast (English-only) and for logs. The web app and the phone translate
 * from the `problem` instead, so the words come from the catalog while the
 * decision stays in core.
 */
export function serverInputMessage(
  parsed: Extract<ParsedServerInput, { ok: false }>,
  input: string,
  t: Translator<"shell">,
): string {
  const trimmed = input.trim();
  switch (parsed.problem) {
    case "empty":
      return t("serverProblems.empty");
    case "insecure": {
      let host = trimmed;
      try {
        host = new URL(trimmed).host;
      } catch {
        /* the typed text is still the best name for it */
      }
      return t("serverProblems.insecure", { host });
    }
    case "invalid-url":
      return t("serverProblems.invalidUrl", { input: trimmed });
  }
}

/** Why the server at `origin` did not pass `checkServer`, in the reader's language. */
export function serverCheckMessage(
  check: Extract<ServerCheck, { ok: false }>,
  origin: string,
  t: Translator<"shell">,
): string {
  const host = serverHost(origin);
  switch (check.problem) {
    case "unreachable":
      return t("serverProblems.unreachable", { host });
    case "not-trackyourtime":
      return t("serverProblems.notTrackYourTime", { host });
    case "unhealthy":
      return t("serverProblems.unhealthy", { host });
  }
}
