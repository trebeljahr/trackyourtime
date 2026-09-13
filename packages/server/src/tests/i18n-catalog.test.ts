import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenMessages,
  icuPlaceholders,
  type MessageTree,
} from "@starter/shared/i18n-catalog";
import { resolveInvoiceLocale } from "@starter/shared/locale";

import { serverMessages } from "../i18n/index.js";

/*
 * The server catalogs' parity test — the same checks as the web client's
 * i18n/catalog-parity.test.ts. `tsc` catches a missing key; only this catches
 * a German message that renames or drops an ICU placeholder.
 */

test("server catalogs: same keys and placeholders in every locale", () => {
  const en = serverMessages.en as unknown as Record<string, MessageTree>;
  const de = serverMessages.de as unknown as Record<string, MessageTree>;
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const namespace of Object.keys(en)) {
    const source = new Map(flattenMessages(en[namespace]));
    const target = new Map(flattenMessages(de[namespace]));
    assert.deepEqual([...target.keys()].sort(), [...source.keys()].sort(), namespace);
    for (const [key, message] of source) {
      assert.deepEqual(
        icuPlaceholders(target.get(key) ?? ""),
        icuPlaceholders(message),
        `${namespace}.${key}`,
      );
    }
  }
});

test("invoice language: override, then client, then issuer, then English", () => {
  assert.equal(resolveInvoiceLocale({ override: "de", clientLocale: "en" }), "de");
  assert.equal(resolveInvoiceLocale({ clientLocale: "de", issuerPreference: "en" }), "de");
  assert.equal(resolveInvoiceLocale({ clientLocale: null, issuerPreference: "de" }), "de");
  // "system" is a device's answer; the server has no device to ask.
  assert.equal(resolveInvoiceLocale({ issuerPreference: "system" }), "en");
  assert.equal(resolveInvoiceLocale({}), "en");
});
