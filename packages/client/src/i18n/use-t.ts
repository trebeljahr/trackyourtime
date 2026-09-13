"use client";

import { useLocale } from "@/i18n/locale-store";
import { getTranslator, type Namespace, type Translator } from "@/i18n/translator";

/**
 * The translator for one namespace, in the locale this component renders in.
 *
 * ```tsx
 * const t = useT("tracker");
 * const tc = useT("common");
 * t("timer.start");                          // typed key
 * t("entries.count", { count: 3 });          // typed ICU arguments
 * t.rich("hint", { b: (chunks) => <b>{chunks}</b> });
 * tc("actions.save");
 * ```
 *
 * Needs no provider: the locale comes from the external store (or a
 * surrounding <FixedLocale>), so existing component tests render unchanged and
 * in English.
 */
export const useT = <N extends Namespace>(namespace: N): Translator<N> =>
  getTranslator(useLocale(), namespace);

/**
 * The same translator for code that is not a component — a toast in a mutation
 * callback, a string built in a plain function. Reads the locale at call time,
 * so call it where the text is produced, not once at module load.
 */
export { translate } from "@/i18n/translate";
