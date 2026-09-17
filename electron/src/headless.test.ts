import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HEADLESS_ENV, isHeadless } from "./headless.ts";

describe("isHeadless", () => {
  it("is on only for the exact value 1", () => {
    assert.equal(isHeadless({ [HEADLESS_ENV]: "1" }), true);
    for (const value of [undefined, "", "0", "true", "yes"]) {
      assert.equal(isHeadless({ [HEADLESS_ENV]: value }), false);
    }
  });
});
