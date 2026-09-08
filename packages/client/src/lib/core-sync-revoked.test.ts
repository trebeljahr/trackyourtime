import { describe, expect, it, vi } from "vitest";
import { createSyncClient, SESSION_REVOKED_CLOSE_CODE } from "@starter/core";

/**
 * A revoked session is the one close the sync client must not retry.
 *
 * The server sweeps live sockets every 60s and closes the ones whose session
 * has gone with 4401 (`ws/session-watch.ts`). The client used to read that as
 * an ordinary disconnect and go into exponential backoff, so a device signed
 * out from Settings → Devices sat in a silent reconnect loop for as long as
 * the app was open — a sync dot that never settles and, on the phone, a dead
 * token still in the Keychain at the next launch.
 *
 * The dangerous half of the fix is the second spec here. "Any disconnect
 * signs you out" would be a much worse bug than the one being fixed: a phone
 * that goes through a tunnel would come back to a login screen with its
 * credential wiped. 1006 — an abnormal close, which is what a dropped network
 * actually produces in a browser — must still reconnect.
 */

type FakeSocket = {
  closed: boolean;
  onopen: (() => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
};

const socketSpy = () => {
  const sockets: FakeSocket[] = [];

  class Fake {
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event?: { code?: number }) => void) | null = null;

    constructor() {
      sockets.push(this as unknown as FakeSocket);
    }

    close(): void {
      this.closed = true;
    }
  }

  return { sockets, FakeSocket: Fake as unknown as typeof WebSocket };
};

describe("createSyncClient on a revoked session", () => {
  it("stops reconnecting and tells the host, once", () => {
    vi.useFakeTimers();
    try {
      const { sockets, FakeSocket } = socketSpy();
      const revoked: number[] = [];
      const client = createSyncClient({
        url: "ws://api.test/api/ws",
        onEvent: () => undefined,
        onSessionRevoked: () => revoked.push(Date.now()),
        WebSocketImpl: FakeSocket,
      });

      client.connect();
      sockets[0].onopen?.();
      expect(client.status()).toBe("open");

      sockets[0].onclose?.({ code: SESSION_REVOKED_CLOSE_CODE });

      expect(revoked).toHaveLength(1);
      expect(client.status()).toBe("closed");

      // No backoff was armed, so no amount of waiting opens another socket.
      vi.advanceTimersByTime(10 * 60_000);
      expect(sockets).toHaveLength(1);

      // And a deliberate nudge — the browser extension's 30-second alarm
      // calls `connect()` on any socket reporting "closed" — must not
      // resurrect a session the server has thrown away.
      client.connect();
      client.reconnect();
      vi.advanceTimersByTime(10 * 60_000);
      expect(sockets).toHaveLength(1);
      expect(revoked).toHaveLength(1);
      expect(client.status()).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reconnects after an abnormal close, and reports no revocation", () => {
    vi.useFakeTimers();
    try {
      const { sockets, FakeSocket } = socketSpy();
      const revoked: number[] = [];
      const client = createSyncClient({
        url: "ws://api.test/api/ws",
        onEvent: () => undefined,
        onSessionRevoked: () => revoked.push(Date.now()),
        WebSocketImpl: FakeSocket,
        minBackoffMs: 1000,
        maxBackoffMs: 1000,
      });

      client.connect();
      sockets[0].onopen?.();

      // 1006: the connection died without a close frame — a lost radio, a
      // proxy timing out, a laptop lid closing.
      sockets[0].onclose?.({ code: 1006 });

      expect(revoked).toHaveLength(0);
      expect(client.status()).toBe("closed");

      vi.advanceTimersByTime(2000);
      expect(sockets).toHaveLength(2);

      sockets[1].onopen?.();
      expect(client.status()).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a close event with no code as an ordinary disconnect", () => {
    vi.useFakeTimers();
    try {
      const { sockets, FakeSocket } = socketSpy();
      const revoked: number[] = [];
      const client = createSyncClient({
        url: "ws://api.test/api/ws",
        onEvent: () => undefined,
        onSessionRevoked: () => revoked.push(Date.now()),
        WebSocketImpl: FakeSocket,
        minBackoffMs: 1000,
        maxBackoffMs: 1000,
      });

      client.connect();
      sockets[0].onopen?.();
      // Hosts with their own socket shim may hand the handler nothing at all.
      // "I could not read a code" must never mean "you were signed out".
      sockets[0].onclose?.();

      expect(revoked).toHaveLength(0);
      vi.advanceTimersByTime(2000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
