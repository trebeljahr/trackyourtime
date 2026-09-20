import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAppUrl, isExternalWebUrl, isTrustedSenderUrl } from "./trust.ts";

describe("isTrustedSenderUrl", () => {
  it("trusts the app's own origin", () => {
    assert.equal(isTrustedSenderUrl("app://-/", null), true);
    assert.equal(isTrustedSenderUrl("app://-/app/track/?x=1", null), true);
  });

  it("refuses everything else in a packaged build", () => {
    for (const url of [
      "app://evil/",
      "https://trackyourtime.dev/app/track/",
      "http://localhost:7130/",
      "file:///Applications/Track%20Your%20Time.app/index.html",
      "data:text/html,<p>hi</p>",
      "about:blank",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isTrustedSenderUrl(url, null), false, String(url));
    }
  });

  it("trusts the dev server's origin only when one is configured", () => {
    assert.equal(isTrustedSenderUrl("http://localhost:7130/app/track/", "http://localhost:7130"), true);
    assert.equal(isTrustedSenderUrl("http://localhost:7131/", "http://localhost:7130"), false);
    assert.equal(isTrustedSenderUrl("http://127.0.0.1:7130/", "http://localhost:7130"), false);
  });

  it("is not fooled by look-alike URLs", () => {
    assert.equal(isAppUrl("app://-.evil.com/"), false);
    assert.equal(isAppUrl("app://-@evil/"), false);
    assert.equal(isAppUrl("https://app/-"), false);
  });
});

describe("isExternalWebUrl", () => {
  it("accepts http and https only", () => {
    assert.equal(isExternalWebUrl("https://trackyourtime.dev/docs/"), true);
    assert.equal(isExternalWebUrl("http://localhost:5159/"), true);
    assert.equal(isExternalWebUrl("file:///etc/passwd"), false);
    assert.equal(isExternalWebUrl("javascript:alert(1)"), false);
    assert.equal(isExternalWebUrl("smb://server/share"), false);
    assert.equal(isExternalWebUrl("not a url"), false);
  });
});
