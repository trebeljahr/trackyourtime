import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_API_URL, normaliseApiUrl, resolveConfig } from "../config.js";
import { encodeQuery } from "../api-client.js";

describe("resolveConfig", () => {
  it("refuses to start without a token, and says where to get one", () => {
    assert.throws(
      () => resolveConfig({}),
      (err: unknown) => err instanceof ConfigError && /Settings → Integrations → API tokens/.test(err.message),
    );
    assert.throws(() => resolveConfig({ TRACKYOURTIME_API_TOKEN: "   " }), ConfigError);
  });

  it("defaults to the hosted API", () => {
    const config = resolveConfig({ TRACKYOURTIME_API_TOKEN: "tt_x" });
    assert.equal(config.apiUrl, DEFAULT_API_URL);
    assert.equal(config.token, "tt_x");
  });

  it("accepts a self-hosted origin", () => {
    const config = resolveConfig({
      TRACKYOURTIME_API_TOKEN: "tt_x",
      TRACKYOURTIME_API_URL: "https://track.example.com",
    });
    assert.equal(config.apiUrl, "https://track.example.com");
  });
});

describe("normaliseApiUrl", () => {
  it("reads the address bar and the documented base as the same origin", () => {
    for (const pasted of [
      "https://track.example.com",
      "https://track.example.com/",
      "https://track.example.com/api",
      "https://track.example.com/api/v1",
      "https://track.example.com/api/v1/",
      "  https://track.example.com  ",
    ]) {
      assert.equal(normaliseApiUrl(pasted), "https://track.example.com", pasted);
    }
  });

  it("keeps a port for a local trial", () => {
    assert.equal(normaliseApiUrl("http://127.0.0.1:5159/"), "http://127.0.0.1:5159");
  });

  it("refuses anything that is not http(s)", () => {
    assert.throws(() => normaliseApiUrl("ftp://example.com"), ConfigError);
    assert.throws(() => normaliseApiUrl("api.trackyourtime.dev"), ConfigError);
  });
});

describe("encodeQuery", () => {
  it("repeats array keys, stringifies scalars and drops absent values", () => {
    assert.equal(
      encodeQuery({ projectIds: ["a", "b"], billable: false, limit: 10, search: undefined, clientId: null }),
      "?projectIds=a&projectIds=b&billable=false&limit=10",
    );
    assert.equal(encodeQuery({}), "");
  });
});
