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

  private readonly channel: string;
  constructor(private readonly deliver: (userId: string, message: SyncMessage) => void, namespace: string) {
    this.channel = `trackyourtime:sync:v1:${namespace}`;
  }

  healthy(): boolean {
    return this.subscribed && this.publisher?.status === "ready";
  }

  async start(redis: Redis): Promise<void> {
    this.publisher = redis.duplicate({ lazyConnect: true, enableOfflineQueue: false, commandTimeout: 1000, autoResendUnfulfilledCommands: false });
    this.subscriber = redis.duplicate({ lazyConnect: true, enableOfflineQueue: false, autoResubscribe: false, autoResendUnfulfilledCommands: false, commandTimeout: 1000 });
    const subscriber = this.subscriber;
    subscriber.on("ready", () => {
      const generation = ++this.generation;
      void subscriber.subscribe(this.channel).then(() => {
        if (!this.stopped && generation === this.generation && subscriber.status === "ready") {
          this.subscribed = true;
        }
      }).catch(() => {
        if (generation === this.generation && !this.stopped) {
          this.subscribed = false;
          subscriber.disconnect(true);
        }
      });
    });
    subscriber.on("close", () => { this.subscribed = false; this.generation += 1; });
    subscriber.on("message", (channel: string, raw: string) => {
      if (channel !== this.channel || this.stopped) return;
      try {
        const packet = JSON.parse(raw);
        if (packet.instance === this.instance || typeof packet.userId !== "string") return;
        if (packet.message?.type !== "tt:sync" || typeof packet.message.event?.kind !== "string") return;
        this.deliver(packet.userId, packet.message);
      } catch {
        // Bad frames and failed sockets cannot stop delivery to other users.
      }
    });
    for (const connection of [this.publisher, subscriber]) connection.on("error", () => {});
    await Promise.all([this.publisher.connect(), subscriber.connect()]).catch(() => {
      // Redis reconnects in the background. Clients retain bounded reconciliation.
    });
  }

  publish(userId: string, message: SyncMessage): void {
    // Always deliver locally, including while Redis is down.
    try { this.deliver(userId, message); } catch { /* Best effort. */ }
    if (!this.healthy()) return;
    void this.publisher!.publish(this.channel, JSON.stringify({ instance: this.instance, userId, message }))
      .catch(() => {
        this.subscribed = false;
        if (!this.stopped) this.subscriber?.disconnect(true);
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
