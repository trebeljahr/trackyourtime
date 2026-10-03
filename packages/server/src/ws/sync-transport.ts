import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { ServerToClientMessage } from "@starter/shared";

type SyncMessage = Extract<ServerToClientMessage, { type: "tt:sync" }>;
export const syncNamespace = (mongoUri: string): string => createHash("sha256")
  .update(mongoUri.replace(/(mongodb(?:\+srv)?:\/\/)(?:[^/]*@)/, "$1").split("?")[0]!)
  .digest("hex");

/** Ephemeral, recipient-projected delivery only. Never queue events across outages. */
export class SyncTransport {
  private readonly instance = randomUUID();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private subscribed = false;
  private stopped = false;
  private generation = 0;
  private subscriptionGeneration = 0;
  private gap = false;
  private recovery: Promise<void> | null = null;

  private readonly channel: string;
  constructor(
    private readonly deliver: (userId: string, message: SyncMessage) => void,
    namespace: string,
    private readonly resync: () => void = () => {},
  ) {
    this.channel = `trackyourtime:sync:v1:${namespace}`;
  }

  healthy(): boolean {
    return !this.stopped && !this.gap && this.subscribed && this.publisher?.status === "ready";
  }

  private requestResync(): void {
    try { this.resync(); } catch { /* One failed socket must not stop recovery. */ }
  }

  private markGap(): void {
    if (this.stopped) return;
    this.generation += 1;
    if (!this.gap) {
      this.gap = true;
      // Heartbeats can miss a short Redis interruption entirely. Reconnecting
      // forces existing clients to refetch even when the gap lasts <10 seconds.
      this.requestResync();
    }
  }

  private recover(): void {
    if (this.stopped || !this.gap || this.recovery || !this.subscribed || this.publisher?.status !== "ready") return;
    const generation = this.generation;
    const recovery = this.publisher.publish(this.channel, JSON.stringify({ instance: this.instance, resync: true }))
      .then(() => {
        if (this.stopped || generation !== this.generation) return;
        this.gap = false;
        // Also refresh clients that reconnected while Redis was unavailable.
        this.requestResync();
      })
      .catch(() => {
        if (!this.stopped) {
          this.markGap();
          this.publisher?.disconnect(true);
        }
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = null;
        // A new ready/subscribe event may have raced the old command's reply.
        if (generation !== this.generation) this.recover();
      });
    this.recovery = recovery;
  }

  async start(redis: Redis): Promise<void> {
    this.publisher = redis.duplicate({ lazyConnect: true, enableOfflineQueue: false, commandTimeout: 1000, autoResendUnfulfilledCommands: false });
    this.subscriber = redis.duplicate({ lazyConnect: true, enableOfflineQueue: false, autoResubscribe: false, autoResendUnfulfilledCommands: false, commandTimeout: 1000 });
    const subscriber = this.subscriber;
    subscriber.on("ready", () => {
      // Separate subscription generation: a publisher disconnect must not
      // discard a still-valid subscribe acknowledgment on this connection.
      const subscriptionGeneration = ++this.subscriptionGeneration;
      void subscriber.subscribe(this.channel).then(() => {
        if (!this.stopped && subscriptionGeneration === this.subscriptionGeneration && subscriber.status === "ready") {
          this.subscribed = true;
          this.recover();
        }
      }).catch(() => {
        if (!this.stopped && subscriptionGeneration === this.subscriptionGeneration) {
          this.subscribed = false;
          this.markGap();
          subscriber.disconnect(true);
        }
      });
    });
    subscriber.on("close", () => { this.subscribed = false; this.subscriptionGeneration += 1; this.markGap(); });
    this.publisher.on("close", () => this.markGap());
    this.publisher.on("ready", () => this.recover());
    subscriber.on("message", (channel: string, raw: string) => {
      if (channel !== this.channel || this.stopped) return;
      try {
        const packet = JSON.parse(raw);
        if (!packet || typeof packet.instance !== "string" || packet.instance === this.instance) return;
        if (packet.resync === true) {
          // A peer may have lost only its publisher. Our own Redis connections
          // can remain healthy throughout, so local health cannot detect this.
          this.requestResync();
          return;
        }
        if (typeof packet.userId !== "string") return;
        if (packet.message?.type !== "tt:sync" || typeof packet.message.event?.kind !== "string") return;
        this.deliver(packet.userId, packet.message);
      } catch {
        // Bad frames and failed sockets cannot stop delivery to other users.
      }
    });
    for (const connection of [this.publisher, subscriber]) connection.on("error", () => {});
    await Promise.all([this.publisher.connect(), subscriber.connect()]).catch(() => {
      this.markGap();
      // Redis reconnects in the background. Clients retain bounded reconciliation.
    });
  }

  publish(userId: string, message: SyncMessage): void {
    if (this.stopped) return;
    // Always deliver locally, including while Redis is down.
    try { this.deliver(userId, message); } catch { /* Best effort. */ }
    if (!this.publisher) return; // Explicit single-process, Redis-less mode.
    if (!this.healthy()) { this.markGap(); this.recover(); return; }
    void this.publisher.publish(this.channel, JSON.stringify({ instance: this.instance, userId, message }))
      .catch(() => {
        this.markGap();
        if (!this.stopped) this.publisher?.disconnect(true);
      });
  }

  stop(): void {
    this.stopped = true;
    this.subscribed = false;
    this.generation += 1;
    this.subscriber?.disconnect();
    this.publisher?.disconnect();
  }
}
