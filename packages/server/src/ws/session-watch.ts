import type { WebSocket } from "ws";

/**
 * Keeps live sockets honest about the session that opened them.
 *
 * The upgrade handshake authenticates once and then the socket is trusted for
 * as long as it stays open — which, for a phone in a pocket, is days. So
 * "sign this device out" in Settings → Devices used to sign out only *half*
 * of it: the next HTTP request 401s, while the socket carried on receiving
 * every sync event for that user. A revoked device that keeps streaming your
 * timers is a revocation hole, not a cosmetic one.
 *
 * Re-checking on a timer, rather than reacting to a revoke event, is the
 * choice here because revocation is not the only way a session stops
 * existing: it also expires, it is deleted by `revokeOtherSessions`, and it
 * can be removed straight out of the database (which is exactly how this was
 * demonstrated). A periodic re-check catches all of those with one rule; an
 * event only catches the one path that remembers to publish it.
 */

/**
 * Close code for a socket dropped because its session is gone.
 *
 * Defined in `@starter/shared` and re-exported here, because the client half
 * of this — stop reconnecting, forget the token, say so — has to match the
 * number exactly, and a client that got it wrong would just reconnect-loop in
 * silence. One definition, on the protocol both ends already import.
 */
export { SESSION_REVOKED_CLOSE_CODE } from "@starter/shared";

/**
 * What a re-check concluded.
 *
 * `unknown` is the important one: a database blip or a thrown lookup must
 * never be read as "revoked", or one bad minute signs every connected device
 * out. Only a clean "there is no session" closes a socket.
 */
export type SessionVerdict = "live" | "revoked" | "unknown";

/** Re-runs the check that authenticated one socket. */
export type SessionProbe = () => Promise<SessionVerdict>;

/**
 * The registry of sockets under watch, and the sweep over them.
 *
 * Deliberately holds no better-auth import: the probe is injected per socket,
 * so the sweep — the part with the branching that matters — is unit-testable
 * without a database or an auth instance.
 */
export class SessionWatch {
  private readonly watched = new Map<WebSocket, SessionProbe>();

  /** Start re-checking `socket`'s session. Re-watching replaces the probe. */
  watch(socket: WebSocket, probe: SessionProbe): void {
    this.watched.set(socket, probe);
  }

  /** Stop watching — on close, or after this sweep already dropped it. */
  unwatch(socket: WebSocket): void {
    this.watched.delete(socket);
  }

  /** How many sockets are currently under watch. */
  get size(): number {
    return this.watched.size;
  }

  /**
   * Re-check every watched socket and hand the revoked ones to `revoke`.
   *
   * Returns how many were dropped. Iterates a copy, because `revoke` closes
   * the socket and the close handler unwatches it mid-loop. A probe that
   * throws counts as `unknown`, so the socket survives to be asked again.
   */
  async sweep(revoke: (socket: WebSocket) => void): Promise<number> {
    let dropped = 0;

    for (const [socket, probe] of [...this.watched]) {
      let verdict: SessionVerdict;
      try {
        verdict = await probe();
      } catch {
        verdict = "unknown";
      }

      if (verdict !== "revoked") continue;

      // Unwatch before revoking: `revoke` closes the socket, and a socket
      // asked twice about a session that is already gone is pure noise.
      this.watched.delete(socket);
      revoke(socket);
      dropped += 1;
    }

    return dropped;
  }
}
