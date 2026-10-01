import { decodeExtensionBridgeRequest, decodeExtensionBridgeReply, isAllowedExtensionBridgeOrigin } from "@starter/shared/extension-bridge";
import { decodeExtensionRelayEnvelope, EXTENSION_RELAY_CHANNEL } from "@starter/shared/extension-relay";

/** Never forward arbitrary page messages to the popup's privileged command API. */
export function installPageRelay(win: Window, runtime: Pick<typeof chrome.runtime, "sendMessage" | "lastError">): () => void {
  if (win.top !== win || !isAllowedExtensionBridgeOrigin(win.location.origin, "production")) return () => {};
  let pending = 0;
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win || event.origin !== win.location.origin) return;
    const envelope = decodeExtensionRelayEnvelope(event.data);
    if (envelope?.direction !== "request" || pending >= 8) return;
    const request = decodeExtensionBridgeRequest(envelope.payload);
    if (!request.ok) return;
    pending++;
    let settled = false;
    const finish = (reply: unknown): void => {
      if (settled) return;
      settled = true;
      pending--;
      clearTimeout(timer);
      const decoded = decodeExtensionBridgeReply(reply);
      if (decoded.ok) win.postMessage({ channel: EXTENSION_RELAY_CHANNEL, direction: "reply", id: envelope.id, payload: decoded.message }, win.location.origin);
    };
    const timer = setTimeout(() => finish(undefined), 5_000);
    try {
      runtime.sendMessage({ channel: EXTENSION_RELAY_CHANNEL, direction: "request", id: envelope.id, payload: request.message }, (reply: unknown) => {
        finish(runtime.lastError ? undefined : reply);
      });
    } catch { finish(undefined); }
  };
  win.addEventListener("message", onMessage);
  return () => win.removeEventListener("message", onMessage);
}
