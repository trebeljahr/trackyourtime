import { describe, expect, it } from "vitest";
import { createSyncClient } from "@starter/core";

/**
 * The socket's bearer token is read at connect time, not captured.
 *
 * On native the token comes out of the Keychain after the app has mounted, and
 * a client that closed over `undefined` reconnects with `undefined` forever —
 * which also means `syncStatus` never reaches "open" and the offline queue
 * never gets its flush trigger. A sign-out/sign-in inside one launch has the
 * same shape with a stale token instead of an absent one.
 */

type Opened = { url: string; protocols?: string | string[] };

const socketSpy = () => {
  const opened: Opened[] = [];

  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string, protocols?: string | string[]) {
      opened.push({ url, protocols });
    }

    close(): void {
      this.onclose?.();
    }
  }

  return { opened, FakeSocket: FakeSocket as unknown as typeof WebSocket };
};

describe("createSyncClient token", () => {
  it("offers no subprotocol when there is no token", () => {
    const { opened, FakeSocket } = socketSpy();

    createSyncClient({
      url: "ws://api.test/api/ws",
      onEvent: () => undefined,
      WebSocketImpl: FakeSocket,
    }).connect();

    expect(opened[0]?.protocols).toBeUndefined();
  });

  it("still accepts a plain string, as Raycast and the extension pass it", () => {
    const { opened, FakeSocket } = socketSpy();

    createSyncClient({
      url: "ws://api.test/api/ws",
      onEvent: () => undefined,
      token: "static-token",
      WebSocketImpl: FakeSocket,
    }).connect();

    expect(opened[0]?.protocols).toEqual(["bearer.static-token"]);
  });

  it("re-reads a getter on every connect", () => {
    const { opened, FakeSocket } = socketSpy();
    // Assigned here and reassigned below: the point of the test is that the
    // client re-reads the getter rather than capturing the first answer.
    let token: string | undefined = undefined;

    const client = createSyncClient({
      url: "ws://api.test/api/ws",
      onEvent: () => undefined,
      token: () => token,
      WebSocketImpl: FakeSocket,
    });

    // Cold launch: the Keychain has not answered yet.
    client.connect();
    expect(opened[0]?.protocols).toBeUndefined();

    client.close();
    token = "hydrated-token";
    client.connect();

    expect(opened[1]?.protocols).toEqual(["bearer.hydrated-token"]);
  });

  it("percent-encodes a token so the subprotocol header stays legal", () => {
    const { opened, FakeSocket } = socketSpy();

    createSyncClient({
      url: "ws://api.test/api/ws",
      onEvent: () => undefined,
      token: () => "a b.c/d",
      WebSocketImpl: FakeSocket,
    }).connect();

    expect(opened[0]?.protocols).toEqual(["bearer.a%20b.c%2Fd"]);
  });
});
