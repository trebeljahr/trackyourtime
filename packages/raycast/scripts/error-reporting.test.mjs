import assert from "node:assert/strict";
import { test } from "node:test";
import { createReporter, parseDsn, safeFrames, scrubErrorText } from "../src/lib/error-reporting.ts";

test("empty or unsafe DSN disables reporting", () => {
  assert.equal(parseDsn(""), null);
  assert.equal(parseDsn("http://key@example.com/2"), null);
  assert.equal(parseDsn("https://key@example.com/not-a-project"), null);
  let calls = 0;
  createReporter("", "release", "build", async () => {
    calls++;
    return new Response();
  })(new Error("oops"), "timer");
  assert.equal(calls, 0);
});

test("Sentry store event contains build and scrubbed diagnostic fields only", () => {
  const calls = [];
  const report = createReporter(
    "https://public@errors.example.test/subpath/42",
    "trackyourtime-raycast@1+abc",
    "abc",
    async (...args) => {
      calls.push(args);
      return new Response(null, { status: 200 });
    },
  );
  const error = new Error("failed https://alice:secret@example.test/invite?id=private for a@b.test Bearer abc123");
  error.stack = "Error: private\n    at run (/Users/alice/code/timer.js:12:4)";
  report(error, "timer");
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, "https://errors.example.test/subpath/api/42/store/");
  const event = JSON.parse(options.body);
  assert.equal(event.release, "trackyourtime-raycast@1+abc");
  assert.deepEqual(event.tags, { platform: "raycast", source: "timer", build_id: "abc" });
  assert.deepEqual(event.exception.values[0].stacktrace.frames, [
    { filename: "timer.js", function: "run", lineno: 12, colno: 4 },
  ]);
  assert.doesNotMatch(options.body, /alice|secret|private|a@b|abc123/);
  assert.match(options.headers["X-Sentry-Auth"], /sentry_key=public/);
});

test("unparseable frames and non-error values expose no arbitrary object data", () => {
  assert.deepEqual(safeFrames("Error\n    at secret (/tmp/private.txt:1:2)"), []);
  assert.equal(scrubErrorText("Bearer secret contact a@b.test"), "Bearer [redacted] contact [email]");
  assert.equal(scrubErrorText('failed /trpc?input={"description":"secret"}'), "failed /trpc");
  const calls = [];
  createReporter("https://key@example.test/2", "release", "build", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response();
  })({ token: "secret" }, "menu-bar");
  assert.equal(calls[0].exception.values[0].value, "Non-Error value thrown");
});
