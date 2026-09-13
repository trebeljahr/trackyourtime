import { flattenMessages, icuPlaceholders, pseudoLocalize, type MessageTree } from "@starter/shared";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

import { NAMESPACES, de, en } from "@/i18n/messages";
import { getMessages, getTranslator } from "@/i18n/translator";

/*
 * `tsc` already refuses a German catalog with a missing or extra key. What it
 * cannot see is inside the strings: a translation that renames `{project}` to
 * `{projekt}`, drops a plural branch's `#`, or breaks the ICU syntax entirely
 * type-checks — every message is just a string — and renders a raw placeholder
 * or throws at runtime, in one language only. This is the test for that.
 */

const german = de as unknown as MessageTree;

describe("catalog parity", () => {
  it("every namespace exists in both locales", () => {
    expect(Object.keys(de).sort()).toEqual([...NAMESPACES].sort());
  });

  for (const namespace of NAMESPACES) {
    describe(namespace, () => {
      const source = new Map(flattenMessages(en[namespace] as MessageTree));
      const target = new Map(flattenMessages(german[namespace] as MessageTree));

      it("has exactly the same keys in German", () => {
        expect([...target.keys()].sort()).toEqual([...source.keys()].sort());
      });

      it("uses the same ICU placeholders and tags in German", () => {
        for (const [key, message] of source) {
          const translated = target.get(key) ?? "";
          expect(icuPlaceholders(translated), `${namespace}.${key}`).toEqual(icuPlaceholders(message));
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
        // Short words legitimately match ("Name", "OK", "Timer", "Deutsch");
        // a whole untranslated sentence is almost always a copy-paste slip.
        for (const [key, message] of source) {
          if (message.split(" ").length < 4) continue;
          expect(target.get(key), `${namespace}.${key} looks untranslated`).not.toBe(message);
        }
      });
    });
  }
});

describe("pseudo-locale", () => {
  it("keeps every placeholder and stays valid ICU", () => {
    for (const namespace of NAMESPACES) {
      for (const [key, message] of flattenMessages(en[namespace] as MessageTree)) {
        const pseudo = pseudoLocalize(message);
        expect(icuPlaceholders(pseudo), `${namespace}.${key}`).toEqual(icuPlaceholders(message));
        expect(() => new IntlMessageFormat(pseudo, "en")).not.toThrow();
      }
    }
  });

  it("is visibly different and longer", () => {
    const t = getTranslator("pseudo", "common");
    const text = t("actions.save");
    expect(text).toMatch(/^\[Šáṽé ~+\]$/);
    expect(text.length).toBeGreaterThan("Save".length * 1.35);
    expect(t("counts.entries", { count: 2 })).toContain("2");
  });

  it("is derived from English, so it can never miss a key", () => {
    expect(Object.keys(getMessages("pseudo"))).toEqual(Object.keys(en));
  });
});

describe("translator", () => {
  it("pluralises by the locale's rules", () => {
    expect(getTranslator("en", "common")("counts.entries", { count: 1 })).toBe("1 entry");
    expect(getTranslator("en", "common")("counts.entries", { count: 3 })).toBe("3 entries");
    expect(getTranslator("de", "common")("counts.entries", { count: 1 })).toBe("1 Eintrag");
    expect(getTranslator("de", "common")("counts.entries", { count: 0 })).toBe("0 Einträge");
  });

  it("interpolates", () => {
    expect(getTranslator("de", "common")("confirm.deleteTitle", { name: "Website" })).toBe(
      "„Website“ löschen?",
    );
  });
});
