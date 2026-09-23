import { describe, expect, it, vi } from "vitest";
import { createSyncClient, type SyncStatus } from "@starter/core";

/**
 * Forcing a reconnect.
 *
 * A phone that has been backgrounded comes back to a socket the server has
 * already terminated — it pings every 10s and drops on the first missed pong —
 * but the client is not told, because the OS froze the connection rather than
 * closing it. Nothing in the old client could ask for a fresh one: reconnection
 * happened only from `onclose`, which in that state may never arrive.
 *
 * The trap in doing it by hand is that `close()` then `connect()` leaves the
 * old socket's close event in flight, and it used to be indistinguishable from
 * the live one's — so it nulled the reference to the socket that had just been
 * opened and scheduled a reconnect on top of it. Two sockets, one of which
 * nothing is listening to.
 */

type FakeSocket = {
  url: string;
  protocols?: string | string[];
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
};

const socketSpy = () => {
  const sockets: FakeSocket[] = [];

  class Fake {
    url: string;
    protocols?: string | string[];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocols = protocols;
      sockets.push(this as unknown as FakeSocket);
    }

    /** Deliberately does NOT fire onclose — a real close event is async. */
    close(): void {
      this.closed = true;
    }
  }

  return { sockets, FakeSocket: Fake as unknown as typeof WebSocket };
};

describe("createSyncClient reconnect", () => {
  it("closes the live socket and opens exactly one more", () => {
    const { sockets, FakeSocket } = socketSpy();
    const client = createSyncClient({
      url: "ws://api.test/api/ws",
      onEvent: () => undefined,
      WebSocketImpl: FakeSocket,
    });

    client.connect();
    sockets[0].onopen?.();
    expect(client.status()).toBe("open");

    client.reconnect();
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(client.status()).toBe("connecting");

    sockets[1].onopen?.();
    expect(client.status()).toBe("open");
  });

  it("ignores the old socket's close event once it has been replaced", () => {
    vi.useFakeTimers();
    try {
      const { sockets, FakeSocket } = socketSpy();
      const statuses: SyncStatus[] = [];
      const client = createSyncClient({
        url: "ws://api.test/api/ws",
        onEvent: () => undefined,
        onStatus: (status) => statuses.push(status),
        WebSocketImpl: FakeSocket,
      });

      client.connect();
      sockets[0].onopen?.();
      client.reconnect();
      sockets[1].onopen?.();

      // The OS finally delivers the close for the socket we walked away from.
      sockets[0].onclose?.();

      expect(client.status()).toBe("open");
      expect(statuses.at(-1)).toBe("open");

      // …and nothing was scheduled on the back of it.
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads the token, so a resume after a sign-in uses the new one", () => {
    const { sockets, FakeSocket } = socketSpy();
    // Assigned here and reassigned below: the point of the test is that the
    // client re-reads the getter rather than capturing the first answer.
    let token: string | undefined = undefined;
    const client = createSyncClient({
      url: "ws://api.test/api/ws",
      onEvent: () => undefined,
      token: () => token,
      WebSocketImpl: FakeSocket,
    });

    client.connect();
    expect(sockets[0].protocols).toBeUndefined();

    token = "fresh";
    client.reconnect();
    expect(sockets[1].protocols).toEqual(["bearer.fresh"]);
  });

  it("does not leave a pending backoff retry behind", () => {
    vi.useFakeTimers();
    try {
      const { sockets, FakeSocket } = socketSpy();
      const client = createSyncClient({
        url: "ws://api.test/api/ws",
        onEvent: () => undefined,
        WebSocketImpl: FakeSocket,
      });

      client.connect();
      // The connection drops on its own: a retry is now armed.
      sockets[0].onclose?.();
      expect(sockets).toHaveLength(1);

      client.reconnect();
      expect(sockets).toHaveLength(2);

      // The armed retry must not add a third once its timer comes due.
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
