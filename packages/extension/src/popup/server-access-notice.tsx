import { useState, type JSX } from "react";
import { serverHost } from "@starter/core";
import { requestServerAccess } from "../lib/server-access";

export type ServerAccessNoticeProps = {
  apiUrl: string;
  /** Re-read the snapshot once Chrome has answered. */
  onAnswered: () => void;
};

/**
 * Chrome has taken away the extension's access to the server in use.
 *
 * A person can remove a site's access at `chrome://extensions` at any time,
 * and every request after that fails in a way that is indistinguishable from
 * a dead network — so without this the popup would say "Offline" about a
 * server that is up, and offer nothing that fixes it. Rendered above every
 * screen, signed in or not, because the fix is the same on all of them.
 *
 * The button calls `requestServerAccess` directly from its click: Chrome only
 * shows the prompt inside a user gesture.
 */
export function ServerAccessNotice({
  apiUrl,
  onAnswered,
}: ServerAccessNoticeProps): JSX.Element {
  const [refused, setRefused] = useState(false);
  const host = serverHost(apiUrl);

  return (
    <div className="notice access" role="alert" data-testid="server-access-notice">
      <p className="access__text">
        Chrome no longer lets the extension reach {host}.
        {refused ? " Access was not given, so the extension still cannot reach it." : ""}
      </p>
      <button
        type="button"
        className="button"
        onClick={() => {
          void requestServerAccess(apiUrl, chrome.permissions).then((verdict) => {
            setRefused(verdict === "refused");
            onAnswered();
          });
        }}
        data-testid="server-access-allow"
      >
        Allow access
      </button>
    </div>
  );
}
