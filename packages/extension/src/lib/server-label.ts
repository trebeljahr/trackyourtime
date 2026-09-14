/**
 * How a server is named in the popup.
 *
 * "Track Your Time cloud" is only true of the hosted API. A development build
 * defaults to a laptop, and calling that "cloud" in its own picker would be a
 * lie the developer then has to see past every time — so the build's default
 * is named by its host when it is not the cloud.
 *
 * Takes the default as an argument rather than importing `DEFAULT_API_URL`,
 * which throws at import time outside a vite build and would make this
 * untestable.
 */
import { sameServerOrigin, serverHost, serverLabel } from "@starter/core";

import type { PopupT } from "../i18n/use-t";

/** The first option in the picker: the server this build was made for. */
export function defaultServerLabel(defaultApiUrl: string, t: PopupT): string {
  const label = serverLabel(defaultApiUrl);
  return label === serverHost(defaultApiUrl)
    ? t("server.defaultServer", { host: serverHost(defaultApiUrl) })
    : label;
}

/** Any server, the way the popup says it in a sentence. */
export function describeServer(apiUrl: string, defaultApiUrl: string, t: PopupT): string {
  return sameServerOrigin(apiUrl, defaultApiUrl)
    ? defaultServerLabel(defaultApiUrl, t)
    : serverLabel(apiUrl);
}
