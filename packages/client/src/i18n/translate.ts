import { getActiveLocale } from "@/i18n/locale-store";
import { getTranslator, type Namespace, type Translator } from "@/i18n/translator";

/**
 * A translator bound to the locale the app is rendering RIGHT NOW, for
 * non-component code:
 *
 * ```ts
 * onError: () => toast.error(translate("common")("errors.generic")),
 * ```
 *
 * Never call it at module scope — the locale switches after hydration, and a
 * string computed at import time would stay English forever.
 */
export const translate = <N extends Namespace>(namespace: N): Translator<N> =>
  getTranslator(getActiveLocale(), namespace);
