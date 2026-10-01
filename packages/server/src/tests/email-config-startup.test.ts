import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";

const configUrl = new URL("../config/env.ts", import.meta.url).href;
function load(settings: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(configUrl)});`], {
    env: { ...process.env, NODE_ENV: "test", ...settings },
    encoding: "utf8", timeout: 15_000,
  });
}
it("rejects incomplete selected SMTP when the server config loads", () => {
  const result = load({ EMAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.example.test", EMAIL_FROM: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EMAIL_TRANSPORT=smtp requires EMAIL_FROM/);
});
it("rejects legacy provider settings without a selector during startup", () => {
  const result = load({ EMAIL_TRANSPORT: "", SMTP_HOST: "smtp.example.test" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set EMAIL_TRANSPORT explicitly/);
});
it("explicit none starts even with leftover incomplete provider settings", () => {
  const result = load({ EMAIL_TRANSPORT: "none", SMTP_HOST: "smtp.example.test", EMAIL_FROM: "", LISTMONK_URL: "invalid" });
  assert.equal(result.status, 0);
});
