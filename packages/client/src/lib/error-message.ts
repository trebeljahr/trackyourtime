import { translate } from "@/i18n/translate";
import type { Translator } from "@/i18n/translator";
import { isNetworkError } from "@/lib/offline";

/** tRPC error codes arrive on `error.data.code`; narrow without `any`. */
const serverCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

/**
 * The text to show for a failed request, in the reader's language where the
 * failure has no more specific words of its own.
 *
 * - A request that never reached the server ("Failed to fetch", "Load failed",
 *   "NetworkError when attempting…") carries the BROWSER's English, which says
 *   nothing a user can act on: it becomes `common.errors.network`.
 * - An internal server error is a fixed English string by design (the server
 *   never leaks its internals): it becomes `fallback`.
 * - Any other server answer keeps its own message. Server messages are not
 *   localised (see CLAUDE.md, Internationalisation), and a specific English
 *   sentence ("Task not found") says more than a generic translated one.
 * - Nothing usable at all: `fallback`.
 *
 * Pass `tc` from a component (`useT("common")`) so the text follows a
 * language switch; toasts in callbacks can omit it and read the locale at
 * call time.
 */
export const userErrorMessage = (
  error: unknown,
  fallback?: string,
  tc: Translator<"common"> = translate("common"),
): string => {
  const generic = fallback ?? tc("errors.generic");
  if (isNetworkError(error)) return tc("errors.network");
  if (serverCode(error) === "INTERNAL_SERVER_ERROR") return generic;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return generic;
};
