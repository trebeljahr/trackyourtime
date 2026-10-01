import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCampaign, sendTransactional } from "../services/newsletter/listmonk.js";

test("newsletter sends carry branded replies without adding recipients", async () => {
  const keys = { LISTMONK_URL: "https://listmonk.example.test", LISTMONK_API_USER: "fixture", LISTMONK_API_TOKEN: "fixture", LISTMONK_TX_TEMPLATE_ID: "1", LISTMONK_CAMPAIGN_TEMPLATE_ID: "2", LISTMONK_LIVE_LIST_ID: "3", LISTMONK_TEST_LIST_ID: "4", LISTMONK_LIST_ID: "3", LISTMONK_FROM: "Project <newsletter@mail.example.com>", LISTMONK_REPLY_TO: "Project <hi@example.com>" };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  Object.assign(process.env, keys);
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ data: { id: 123 } }), { status: 200 });
  };
  try {
    await sendTransactional({ to: "one@example.com", subject: "Fixture", html: "<p>Fixture</p>" });
    await sendCampaign({ name: "Fixture", subject: "Fixture", html: "<p>Fixture</p>", text: "Fixture", draft: true });
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.deepEqual(body.headers, [{ "Reply-To": keys.LISTMONK_REPLY_TO }]);
      assert.equal(body.from_email, keys.LISTMONK_FROM);
      assert.equal(body.cc, undefined);
      assert.equal(body.bcc, undefined);
    }
    assert.equal(bodies[0]?.subscriber_email, "one@example.com");
    assert.deepEqual(bodies[1]?.lists, [process.env.NODE_ENV === "production" ? 3 : 4]);
    process.env.LISTMONK_REPLY_TO = "hi@example.com\r\nBcc: other@example.com";
    await assert.rejects(sendTransactional({ to: "one@example.com", subject: "Fixture", html: "Fixture" }), /Invalid LISTMONK_REPLY_TO/);
    assert.equal(bodies.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
