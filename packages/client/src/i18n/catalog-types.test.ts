import type { Translation } from "@starter/shared";
import { describe, expect, it } from "vitest";

import { getTranslator } from "@/i18n/translator";

/*
 * Type-level guarantees, checked by `pnpm typecheck` rather than at runtime:
 * every `@ts-expect-error` below must still be an error, or `tsc` fails on the
 * unused directive. If one of these starts compiling, the catalog typing has
 * silently stopped protecting translators and call sites.
 */

const source = { greeting: "Hello {name}", nested: { count: "{count, plural, one {#} other {#}}" } } as const;

describe("catalog typing", () => {
  it("is enforced by tsc", () => {
    const complete: Translation<typeof source> = { greeting: "Hallo {name}", nested: { count: "{count, plural, one {#} other {#}}" } };

    // @ts-expect-error — a translation missing a key does not compile
    const missing: Translation<typeof source> = { greeting: "Hallo {name}" };

    const extra: Translation<typeof source> = {
      greeting: "Hallo {name}",
      nested: { count: "#" },
      // @ts-expect-error — nor does one with a key the source lacks
      farewell: "Tschüss",
    };

    const t = getTranslator("de", "common");
    // @ts-expect-error — an unknown key does not compile
    t("actions.nope");
    // @ts-expect-error — a message with arguments requires them
    t("counts.entries");
    // @ts-expect-error — and requires them by name
    t("confirm.deleteTitle", { title: "x" });
    const ok: string = t("confirm.deleteTitle", { name: "x" });

    expect([complete, missing, extra, ok]).toHaveLength(4);
  });
});
