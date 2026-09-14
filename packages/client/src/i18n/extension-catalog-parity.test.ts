import { flattenMessages, icuPlaceholders, type MessageTree } from "@starter/shared";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

import { background as deBackground } from "../../../extension/src/i18n/messages/de/background";
import { popup as dePopup } from "../../../extension/src/i18n/messages/de/popup";
import { background as enBackground } from "../../../extension/src/i18n/messages/en/background";
import { popup as enPopup } from "../../../extension/src/i18n/messages/en/popup";

/*
 * The browser extension has no test runner of its own, and `tsc` there sees
 * only keys. The same string-level checks as catalog-parity.test.ts, run over
 * the extension's catalogs from here: renamed placeholders, broken ICU and
 * untranslated sentences type-check and fail only at runtime, in one language.
 */

const NAMESPACES = {
  popup: [enPopup, dePopup],
  background: [enBackground, deBackground],
} as const;

describe("extension catalog parity", () => {
  for (const [namespace, [english, german]] of Object.entries(NAMESPACES)) {
    describe(namespace, () => {
      const source = new Map(flattenMessages(english as unknown as MessageTree));
      const target = new Map(flattenMessages(german as unknown as MessageTree));

      it("has exactly the same keys in German", () => {
        expect([...target.keys()].sort()).toEqual([...source.keys()].sort());
      });

      it("uses the same ICU placeholders and tags in German", () => {
        for (const [key, message] of source) {
          expect(icuPlaceholders(target.get(key) ?? ""), `${namespace}.${key}`).toEqual(
            icuPlaceholders(message),
          );
        }
      });

      it("every message is valid ICU in its own locale", () => {
        for (const [key, message] of source) {
          expect(() => new IntlMessageFormat(message, "en"), `en ${namespace}.${key}`).not.toThrow();
        }
        for (const [key, message] of target) {
          expect(() => new IntlMessageFormat(message, "de"), `de ${namespace}.${key}`).not.toThrow();
        }
      });

      it("no German message is left identical to a long English one", () => {
        for (const [key, message] of source) {
          // Words outside simple placeholders: "{duration} · {day}" has none.
          const words = message.replace(/\{[^{}]*\}/g, "").split(" ").filter((w) => /\p{L}/u.test(w));
          if (words.length < 4) continue;
          expect(target.get(key), `${namespace}.${key} looks untranslated`).not.toBe(message);
        }
      });
    });
  }
});
