import { DESKTOP_APP_ORIGIN } from "./desktop-bridge.js";

/**
 * The document origins of the store-distributed clients.
 *
 * The browser extension from the Chrome Web Store and the iOS and Android apps
 * are ONE build each, installed by people who point them at whatever server
 * they like — the hosted one or their own. Every one of them runs in a browser
 * engine, so every sign-in carries an `Origin`, and better-auth refuses an
 * origin it does not trust with `403 INVALID_ORIGIN` before the password is
 * checked. A self-hosted server that has to be told these by hand is a server
 * the store apps cannot use until somebody reads the troubleshooting section.
 *
 * So they live here, in code, and `TRUST_STORE_APPS=true` (the self-host
 * default) adds all of them to the server's trusted origins.
 */

/**
 * The public half of the key that pins the store extension's id.
 *
 * Chrome derives an extension's id from the SHA-256 of this key's DER bytes,
 * so committing it fixes `chrome-extension://<id>` before the first upload —
 * which is the only way a server released today can already trust the
 * extension a store approves next month. Public by construction: it is copied
 * into every shipped `manifest.json`. The private half never enters the repo.
 *
 * `EXTENSION_KEY` at build time still overrides it, for a fork that publishes
 * its own listing.
 */
export const STORE_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxUtsVmu2FXo99hXcLk0ot48DeRuxmTV1+K8sVul2GjdQEy0gxAUNtiRcd/+/4/wZSqwyRqQVia65AVavVfKtJNXqCd3yUxNrVrrdEEOxOedXuQb7RZ/ZIWeU2f6nhyNxJaKXYwrKvE9DvdgSxXmLvQccXLptUFyyF3aY7E4N15OUrDMtHEmVF3L+1FlFQa2rskcMYPHB0OJI2UAmHHKovko6BJUiUEmPYqKsIftZMXcq+2Q51khP3rPQoLYscCVl6oTNgoBwBEeV9E+34Px1Ws5YCxfl5NAQJdxKfLlpsAkmffzOYF9+5Nhzs5k812FWGAO41xHUiRajBHKuPV8aeQIDAQAB";

/**
 * The id {@link STORE_EXTENSION_KEY} produces. Written out rather than derived
 * at runtime because the browser bundle has no SHA-256 to derive it with; a
 * server test recomputes it, so the two cannot drift.
 */
export const STORE_EXTENSION_ID = "opibnndhibnigcfgfbgbipakadhnbjfi";

/** The iOS app's document origin (WKWebView, Capacitor's default scheme). */
export const IOS_APP_ORIGIN = "capacitor://localhost";

/** The Android app's document origin (Capacitor's default scheme there). */
export const ANDROID_APP_ORIGIN = "https://localhost";

/**
 * Every store client's origin, in the order the docs list them. The last is
 * the desktop app's: the privileged `app://-` scheme the Electron shell serves
 * its export from (`electron/src/protocol.ts`), defined beside the bridge type
 * in `desktop-bridge.ts`.
 */
export const STORE_APP_ORIGINS: readonly string[] = [
  IOS_APP_ORIGIN,
  ANDROID_APP_ORIGIN,
  `chrome-extension://${STORE_EXTENSION_ID}`,
  DESKTOP_APP_ORIGIN,
];

/**
 * The extension schemes whose origin is a random per-install UUID.
 *
 * Chromium derives an extension's id from its public key, so
 * `chrome-extension://<id>` is a constant this repo pins
 * ({@link STORE_EXTENSION_ID}) and a server lists. Firefox and Safari hand
 * every install a fresh UUID instead, so their origins can only ever be
 * trusted by SHAPE — see `auth/extension-origins.ts` on the server, which
 * narrows that trust to requests carrying no session cookie, and
 * docs/firefox-extension-spike.md for what a Firefox extension actually sends.
 *
 * Here so both ends agree on what one looks like: the server decides trust
 * with it, and the extension's popup decides which setting to name when a
 * server refuses it.
 */
export const RANDOM_EXTENSION_ORIGIN_SCHEMES: readonly string[] = [
  "moz-extension:",
  "safari-web-extension:",
];

const RANDOM_EXTENSION_ORIGIN =
  /^(moz-extension|safari-web-extension):\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `origin` is one of those browser-assigned extension origins —
 * scheme, `//`, a UUID, and nothing else. A shape check rather than a scheme
 * check, because this is what stands between a browser's own origin and a
 * string somebody composed.
 */
export function isRandomExtensionOrigin(origin: string | undefined | null): boolean {
  return typeof origin === "string" && RANDOM_EXTENSION_ORIGIN.test(origin);
}
