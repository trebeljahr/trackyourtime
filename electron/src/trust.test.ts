import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAppUrl, isExternalWebUrl, isOsHandledUrl, isPermissionGranted, isTrustedSenderUrl } from "./trust.ts";

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

  it("never lets a dev URL without a real origin trust opaque documents", () => {
    // file:, data: and about: all have the opaque origin "null"; comparing
    // origins alone made ELECTRON_DEV_URL=file:///… trust every data: frame.
    for (const devUrl of ["file:///tmp/index.html", "data:text/html,x", "about:blank", "not a url"]) {
      for (const url of ["data:text/html,<p>hi</p>", "about:blank", "file:///etc/hosts"]) {
        assert.equal(isTrustedSenderUrl(url, devUrl), false, `${url} with dev ${devUrl}`);
      }
    }
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

describe("isPermissionGranted", () => {
  it("grants notifications and clipboard writes to the app's own documents", () => {
    assert.equal(isPermissionGranted("notifications", "app://-/app/track/", null), true);
    assert.equal(isPermissionGranted("clipboard-sanitized-write", "app://-/app/members/", null), true);
    assert.equal(isPermissionGranted("clipboard-sanitized-write", "app://-", null), true);
  });

  it("denies everything else, including clipboard reads", () => {
    for (const permission of ["clipboard-read", "media", "geolocation", "midi", "openExternal", "fullscreen"]) {
      assert.equal(isPermissionGranted(permission, "app://-/", null), false, permission);
    }
  });

  it("grants nothing to a document outside the app", () => {
    for (const url of ["https://example.com/", "data:text/html,x", "about:blank", "", null]) {
      assert.equal(isPermissionGranted("clipboard-sanitized-write", url, null), false, String(url));
      assert.equal(isPermissionGranted("notifications", url, null), false, String(url));
    }
  });
});

describe("isOsHandledUrl", () => {
  it("hands web and mail links to the OS", () => {
    assert.equal(isOsHandledUrl("https://trackyourtime.dev/docs/"), true);
    assert.equal(isOsHandledUrl("http://localhost:5159/"), true);
    assert.equal(isOsHandledUrl("mailto:support@example.com"), true);
  });

  it("refuses every other scheme", () => {
    for (const url of ["file:///etc/hosts", "app://-/", "javascript:alert(1)", "data:text/html,x", "smb://host/share", "x-apple.systempreferences:", "not a url"]) {
      assert.equal(isOsHandledUrl(url), false, url);
    }
  });
});
