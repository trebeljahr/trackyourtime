/** Firefox's page/content-script transport. Payloads use the existing bridge decoders. */
export const EXTENSION_RELAY_CHANNEL = "trackyourtime.extension-relay";
export const FIREFOX_EXTENSION_ID = "trackyourtime@ricoslabs.com";

export type ExtensionRelayEnvelope = {
  channel: typeof EXTENSION_RELAY_CHANNEL;
  direction: "request" | "reply";
  id: string;
  payload: unknown;
};

export function decodeExtensionRelayEnvelope(value: unknown): ExtensionRelayEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.channel !== EXTENSION_RELAY_CHANNEL ||
      (record.direction !== "request" && record.direction !== "reply") ||
      typeof record.id !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(record.id)) return null;
  return { channel: EXTENSION_RELAY_CHANNEL, direction: record.direction, id: record.id, payload: record.payload };
}
