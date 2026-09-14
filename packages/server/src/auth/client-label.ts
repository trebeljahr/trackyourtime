// Naming the things in Settings → Devices.
//
// Everything here is cosmetic. The client kind is self-reported — a caller
// can claim to be Raycast when it is curl — so it labels a row and NOTHING
// else. Never branch on it for authorization.
import type { ClientKind } from "@starter/shared";

/** Header a first-party client sets to name itself in the devices list. */
export const CLIENT_HEADER = "x-trackyourtime-client";

/** `client_id` values the device-authorization flow accepts. */
export const DEVICE_FLOW_CLIENT_IDS: Record<string, ClientKind> = {
  "trackyourtime-raycast": "raycast",
  "trackyourtime-cli": "cli",
  "trackyourtime-extension": "extension",
  "trackyourtime-desktop": "desktop",
  "trackyourtime-mobile": "mobile",
};

const CLIENT_KINDS: readonly ClientKind[] = [
  "web",
  "desktop",
  "mobile",
  "raycast",
  "extension",
  "cli",
  "unknown",
];

const CLIENT_LABELS: Record<ClientKind, string> = {
  web: "Web app",
  desktop: "Desktop app",
  mobile: "Mobile app",
  raycast: "Raycast",
  extension: "Browser extension",
  cli: "Command line",
  unknown: "Unknown client",
};

/** Narrow an arbitrary self-reported string to a known client kind. */
export function normalizeClientKind(value: unknown): ClientKind {
  if (typeof value !== "string") return "unknown";
  const candidate = value.trim().toLowerCase();
  const direct = CLIENT_KINDS.find((kind) => kind === candidate);
  if (direct) return direct;
  return DEVICE_FLOW_CLIENT_IDS[candidate] ?? "unknown";
}

/**
 * Best-effort platform out of a user agent — enough to tell two browsers on
 * two machines apart, deliberately not fingerprinting.
 */
function platformFromUserAgent(userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes("android")) return "Android";
  if (/iphone|ipad|ipod/.test(ua)) return "iOS";
  if (ua.includes("mac os") || ua.includes("macintosh") || ua.includes("darwin"))
    return "macOS";
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("linux")) return "Linux";
  return null;
}

/** Browser name, for the common case of several browsers on one machine. */
function browserFromUserAgent(userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  // Order matters: every Chromium UA also claims Safari, Edge also claims Chrome.
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
  if (ua.includes("firefox")) return "Firefox";
  if (ua.includes("chrome") || ua.includes("chromium")) return "Chrome";
  if (ua.includes("safari")) return "Safari";
  return null;
}

/**
 * The label a device row gets.
 *
 * A self-declared client wins ("Raycast on macOS"). Otherwise fall back to
 * reading the user agent, which is all a plain browser session gives us.
 */
export function describeClient(
  client: ClientKind,
  userAgent: string | null,
): string {
  const platform = userAgent ? platformFromUserAgent(userAgent) : null;

  if (client === "web" || client === "unknown") {
    const browser = userAgent ? browserFromUserAgent(userAgent) : null;
    if (browser && platform) return `${browser} on ${platform}`;
    if (browser) return browser;
    if (platform) return `${CLIENT_LABELS.web} on ${platform}`;
    return CLIENT_LABELS[client];
  }

  const base = CLIENT_LABELS[client];
  return platform ? `${base} on ${platform}` : base;
}

/** Read the self-reported client kind off an incoming request's headers. */
export function clientKindFromHeaders(
  headers: Headers | undefined | null,
): ClientKind {
  if (!headers) return "unknown";
  try {
    return normalizeClientKind(headers.get(CLIENT_HEADER));
  } catch {
    return "unknown";
  }
}
