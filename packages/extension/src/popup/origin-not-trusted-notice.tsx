import type { JSX } from "react";
import { serverHost } from "@starter/core";
import { useT } from "../i18n/use-t";
import { extensionOrigin, originNotTrustedKey } from "./errors";

export type OriginNotTrustedNoticeProps = {
  apiUrl: string;
};

/**
 * The server in use said it does not trust this extension's origin.
 *
 * Every request the extension makes is a CORS request, and a refused one
 * fails exactly like a dead network — so without this the popup would say
 * "Offline" about a server that is up. Nothing in the popup can fix it, so the
 * notice names the setting and the value for the server's admin. Rendered
 * above every screen, signed in or not. Queued changes stay queued meanwhile.
 */
export function OriginNotTrustedNotice({ apiUrl }: OriginNotTrustedNoticeProps): JSX.Element {
  const t = useT("popup");
  return (
    <p className="notice origin-notice" role="alert" data-testid="origin-not-trusted">
      {t(`errors.${originNotTrustedKey()}`, {
        server: serverHost(apiUrl),
        origin: extensionOrigin(),
      })}
    </p>
  );
}
