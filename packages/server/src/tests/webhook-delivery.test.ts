// The two decisions the sender makes without a database in front of it: is
// this target still safe to dial, and did that response count as delivered.
//
// The SSRF half is tested here rather than in webhook-ssrf.test.ts because
// what matters at THIS layer is not the address table (that file owns it) but
// that the check runs again per attempt, through a real DNS lookup, on a name
// rather than a literal. A create-time-only check is decorative: a name that
// answered publicly on Monday can answer 169.254.169.254 on Tuesday.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { assertDeliverableUrl } from "../services/webhooks/ssrf.js";
import {
  approvedDeliveryAddresses,
  classifyResponseStatus,
  postSignedDelivery,
} from "../services/webhooks/delivery.js";

describe("assertDeliverableUrl", () => {
  it("rejects a hostname that resolves to a private address", async () => {
    // `localhost` is the case a literal-address check misses entirely: the
    // URL contains no address at all, so the guard is only correct if it
    // resolves the name first. Resolved from the hosts file, so this needs
    // no network.
    await assert.rejects(() => assertDeliverableUrl("https://localhost/hook"));
  });

  it("rejects a private literal address", async () => {
    await assert.rejects(() =>
      assertDeliverableUrl("https://169.254.169.254/latest/meta-data/"),
    );
    await assert.rejects(() => assertDeliverableUrl("https://10.1.2.3/hook"));
    await assert.rejects(() => assertDeliverableUrl("https://[::1]/hook"));
  });

  it("rejects every scheme but http(s)", async () => {
    // `file:` and friends turn a delivery into a local read.
    await assert.rejects(() => assertDeliverableUrl("file:///etc/passwd"));
    await assert.rejects(() => assertDeliverableUrl("gopher://8.8.8.8/x"));
    await assert.rejects(() => assertDeliverableUrl("not a url at all"));
  });

  it("rejects plaintext http to a public host", async () => {
    // Signed or not, the payload is somebody's time and rates in clear text.
    await assert.rejects(() => assertDeliverableUrl("http://8.8.8.8/hook"));
  });

  it("accepts an ordinary public https target", async () => {
    const url = await assertDeliverableUrl("https://1.1.1.1/hooks/trackyourtime");
    assert.equal(url.hostname, "1.1.1.1");
  });
});

describe("classifyResponseStatus", () => {
  it("treats 2xx as delivered", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      assert.equal(classifyResponseStatus(status), null, `status ${status}`);
    }
  });

  it("treats a redirect as a failure rather than a hop to follow", () => {
    // Following it would hand the SSRF guard the wrong URL: the addresses
    // behind the subscription's own host were checked, and a `Location:`
    // pointing at the metadata endpoint was checked by nothing.
    for (const status of [301, 302, 307, 308]) {
      const failure = classifyResponseStatus(status);
      assert.deepEqual(failure, {
        error: "redirect_not_followed",
        responseStatus: status,
      });
    }
  });

  it("records the status on any other failure", () => {
    assert.deepEqual(classifyResponseStatus(500), {
      error: "http_500",
      responseStatus: 500,
    });
    assert.deepEqual(classifyResponseStatus(410), {
      error: "http_410",
      responseStatus: 410,
    });
    // 4xx is retried like anything else: a receiver answering 401 during a
    // credential rotation is the ordinary case, and giving up on the first
    // one would drop events nobody knows were dropped.
    assert.notEqual(classifyResponseStatus(401), null);
  });
});

describe("approvedDeliveryAddresses", () => {
  // The addresses `assertDeliverableUrl` validates used to be thrown away, and
  // the request then resolved the name a SECOND time. These are the literals
  // the socket is pinned to, so the address that was checked is the address
  // that is dialled — a 0-TTL record cannot answer public for the check and
  // 169.254.169.254 for the connection.
  it("rejects a hostname that resolves to a private address", async () => {
    await assert.rejects(() =>
      approvedDeliveryAddresses(new URL("https://localhost/hook")),
    );
  });

  it("rejects a private literal", async () => {
    await assert.rejects(() =>
      approvedDeliveryAddresses(new URL("https://169.254.169.254/latest/")),
    );
    await assert.rejects(() =>
      approvedDeliveryAddresses(new URL("https://[::1]/hook")),
    );
  });

  it("hands back the public literal it was given", async () => {
    assert.deepEqual(
      await approvedDeliveryAddresses(new URL("https://1.1.1.1/hook")),
      ["1.1.1.1"],
    );
    // Unbracketed: `dns`/`net` want the bare address, WHATWG URL keeps the
    // brackets, and connecting to "[2606:…]" fails as an unknown host.
    assert.deepEqual(
      await approvedDeliveryAddresses(
        new URL("https://[2606:4700:4700::1111]/hook"),
      ),
      ["2606:4700:4700::1111"],
    );
  });
});

type CapturedRequest = {
  method: string;
  url: string;
  host: string | undefined;
  contentType: string | undefined;
  body: string;
};

type TestServer = {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

/** A loopback listener that records what reached it. */
async function startServer(
  respond: (response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const host = request.headers.host;
      const contentType = request.headers["content-type"];
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        host: Array.isArray(host) ? host[0] : host,
        contentType: Array.isArray(contentType) ? contentType[0] : contentType,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("listener has no port");
  }

  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("postSignedDelivery", () => {
  it("connects to the pinned address, not to the URL's hostname", async () => {
    const server = await startServer((response) => {
      response.writeHead(202).end();
    });
    try {
      // `webhook.invalid` resolves to nothing anywhere: if this request went
      // through a resolver rather than to the pinned literal it could not
      // arrive at all, which is exactly what makes this the pinning test.
      const url = new URL(`http://webhook.invalid:${server.port}/hooks/x?a=1`);
      const status = await postSignedDelivery({
        url,
        address: "127.0.0.1",
        headers: {
          "Content-Type": "application/json",
          "X-TrackYourTime-Event": "entry.stopped",
        },
        body: '{"id":"d1"}',
        timeoutMs: 2_000,
      });

      assert.equal(status, 202);
      assert.equal(server.requests.length, 1);
      const [received] = server.requests;
      assert.ok(received);
      assert.equal(received.method, "POST");
      assert.equal(received.url, "/hooks/x?a=1");
      // The name, not the literal: a receiver on a shared address routes on
      // `Host`, and pinning must not turn its virtual host into 127.0.0.1.
      assert.equal(received.host, `webhook.invalid:${server.port}`);
      assert.equal(received.contentType, "application/json");
      // The exact signed bytes, unchanged by the transport swap.
      assert.equal(received.body, '{"id":"d1"}');
    } finally {
      await server.close();
    }
  });

  it("does not follow a redirect — it reports it", async () => {
    const server = await startServer((response) => {
      response
        .writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" })
        .end();
    });
    try {
      const status = await postSignedDelivery({
        url: new URL(`http://webhook.invalid:${server.port}/hook`),
        address: "127.0.0.1",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 2_000,
      });

      assert.equal(status, 302);
      // One request, and the `Location` was never dialled: it is a second
      // destination chosen by the receiver and validated by nobody.
      assert.equal(server.requests.length, 1);
      assert.deepEqual(classifyResponseStatus(status), {
        error: "redirect_not_followed",
        responseStatus: 302,
      });
    } finally {
      await server.close();
    }
  });

  it("gives up on a receiver that never answers", async () => {
    // Named `TimeoutError` because that string is what the delivery log stores
    // and what an already-recorded row means.
    const server = await startServer(() => {});
    try {
      await assert.rejects(
        () =>
          postSignedDelivery({
            url: new URL(`http://webhook.invalid:${server.port}/hook`),
            address: "127.0.0.1",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            timeoutMs: 50,
          }),
        (error: unknown) => error instanceof Error && error.name === "TimeoutError",
      );
    } finally {
      await server.close();
    }
  });
});
