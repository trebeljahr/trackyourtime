import { test } from "node:test";
import assert from "node:assert/strict";
import { hmrOptions } from "./hmr-options.mjs";

test("live default, local alias, and pnpm argument forwarding", () => {
  assert.deepEqual(hmrOptions([]), { mode: "hosted", apiUrl: undefined });
  for (const args of [["--local"], ["--backend", "local"], ["--", "--backend=local"]]) {
    assert.deepEqual(hmrOptions(args), { mode: "local-api", apiUrl: undefined });
  }
});
test("custom origins select the matching extension identity", () => {
  assert.deepEqual(hmrOptions(["--backend", "http://127.0.0.1:54321/"]), { mode: "local-api", apiUrl: "http://127.0.0.1:54321" });
  assert.deepEqual(hmrOptions(["--backend=https://api.example.com/"]), { mode: "hosted", apiUrl: "https://api.example.com" });
});
test("explicit flags override environment without leaking a previous backend", () => {
  const env = { VITE_API_URL: "https://api.example.com" };
  assert.equal(hmrOptions([], env).apiUrl, env.VITE_API_URL);
  assert.deepEqual(hmrOptions(["--backend", "live"], env), { mode: "hosted", apiUrl: undefined });
  assert.deepEqual(hmrOptions(["--local"], env), { mode: "local-api", apiUrl: undefined });
});
test("reject ambiguous flags and malformed or credential-bearing URLs", () => {
  for (const args of [["--backend"], ["--backend="], ["--other"], ["--local", "--backend", "live"]]) assert.throws(() => hmrOptions(args));
  for (const url of ["example.com", "ftp://example.com", "https://u:p@example.com", "https://example.com/api", "https://example.com?q=1", "https://example.com/#token"]) assert.throws(() => hmrOptions(["--backend", url]));
});
