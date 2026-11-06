/**
 * A counter that moves whenever this device's encrypted account inventory is
 * written, in this tab or another one (BroadcastChannel). The content route
 * keys its short-lived decision cache on it (private-content-route.ts), so a
 * changed inventory is read again before the next request.
 */
let revision = 0;
const CHANNEL = "trackyourtime-private-inventory";
let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== "undefined") {
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => { revision++; };
  } catch { channel = null; }
}
export const privateInventoryRevision = (): number => revision;
export function bumpPrivateInventoryRevision(): void {
  revision++;
  try { channel?.postMessage(null); } catch { /* Other tabs fall back to the cache's time limit. */ }
}
