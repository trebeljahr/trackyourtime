import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  Toast,
  open,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { pollForDeviceSession, startDeviceAuthorization, type DeviceAuthorization } from "../vendor/index.js";
import { useEffect, useRef, useState } from "react";
import { CLIENT_ID, getStoredSession, signOut, storeSession } from "../lib/auth.js";
import { DEFAULT_ORIGINS, apiUrl, hostLabel, usesLocalDefaults, webLink, webUrl } from "../lib/preferences.js";
import { getTrackYourTime } from "../lib/api.js";
import { adoptUnownedHere } from "../lib/offline.js";
import { describeFailure, refreshMenuBar } from "../lib/ui.js";
import { APP_VERSION } from "../lib/version.js";

/**
 * RFC 8628 device flow.
 *
 * Raycast never sees the password: it asks the server for a short code, the
 * user approves that code in a browser that is already signed in, and Raycast
 * ends up with a normal better-auth session token it can revoke from
 * Settings → Devices like any other device.
 */
type Phase =
  | { kind: "checking" }
  | { kind: "signedIn"; email: string | null }
  | { kind: "pairing"; authorization: DeviceAuthorization }
  | { kind: "failed"; message: string };

export function SignIn(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    let cancelled = false;

    const run = async (): Promise<void> => {
      const existing = await getStoredSession();
      if (cancelled) return;
      if (existing && attempt === 0) {
        setPhase({ kind: "signedIn", email: existing.email });
        return;
      }

      const options = { baseUrl: apiUrl(), clientId: CLIENT_ID, clientVersion: APP_VERSION } as const;

      try {
        const authorization = await startDeviceAuthorization(options);
        if (cancelled) return;
        setPhase({ kind: "pairing", authorization });

        // Opening the prefilled page is the whole point of the flow — the
        // user should not have to retype a code they can just confirm.
        if (authorization.verificationUriComplete) {
          await open(authorization.verificationUriComplete);
        }

        const session = await pollForDeviceSession(options, authorization.deviceCode, {
          intervalSeconds: authorization.intervalSeconds,
          timeoutSeconds: authorization.expiresInSeconds,
          signal: abort.signal,
        });
        if (cancelled) return;

        await storeSession(session);

        /*
         * Claim and send whatever this Mac queued before it had an account to
         * stamp rows with — work from a build that predates ownership, or from
         * the window between launching and the session resolving. Adoption
         * comes first: the flush filter refuses a row it cannot attribute, so
         * without it the very rows this pairing exists to rescue would sit
         * there being counted as somebody else's.
         */
        const adopted = session.userId ? await adoptUnownedHere(session.userId) : 0;
        const stuck = await (await getTrackYourTime()).sync().catch(() => 0);

        await refreshMenuBar();
        setPhase({ kind: "signedIn", email: session.email });
        await showToast({
          style: Toast.Style.Success,
          title: "Raycast paired with Track Your Time",
          message:
            adopted > 0 && stuck === 0
              ? `${session.email ?? "Signed in"} · ${adopted} queued change${adopted === 1 ? "" : "s"} sent`
              : (session.email ?? undefined),
        });
      } catch (error) {
        if (cancelled) return;
        setPhase({ kind: "failed", message: describeFailure(error) });
      }
    };

    void run();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [attempt]);

  const retry = (): void => {
    abortRef.current?.abort();
    setPhase({ kind: "checking" });
    setAttempt((value) => value + 1);
  };

  if (phase.kind === "checking") {
    return <Detail isLoading navigationTitle="Track Your Time" markdown="Connecting to Track Your Time…" />;
  }

  if (phase.kind === "signedIn") {
    return (
      <Detail
        navigationTitle="Track Your Time"
        markdown={[
          "# Paired",
          "",
          "Raycast can start, stop and edit your timers.",
          "",
          "Run **Timer Menu Bar** once to put the clock in the menu bar, and",
          "give **Timer** a hotkey in Raycast Settings → Extensions.",
          "",
          "This session appears as **Raycast** under Settings → Devices in the",
          "web app — sign it out there to revoke it.",
        ].join("\n")}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.Label title="Account" text={phase.email ?? "Signed in"} icon={Icon.Person} />
            <Detail.Metadata.Label title="Server" text={hostLabel(apiUrl())} />
          </Detail.Metadata>
        }
        actions={
          <ActionPanel>
            <Action.OpenInBrowser title="Open Web App" url={webLink("/app/track")} />
            <Action
              title="Sign out"
              icon={Icon.Logout}
              style={Action.Style.Destructive}
              onAction={async () => {
                await signOut();
                await refreshMenuBar();
                await showToast({
                  style: Toast.Style.Success,
                  title: "Signed out",
                });
                setPhase({ kind: "failed", message: "Signed out." });
              }}
            />
            <Action title="Pair Again" icon={Icon.Repeat} onAction={retry} />
          </ActionPanel>
        }
      />
    );
  }

  if (phase.kind === "pairing") {
    const { userCode, verificationUri, verificationUriComplete } = phase.authorization;
    const approvalUrl = verificationUriComplete || verificationUri || webLink("/app/device");

    return (
      <Detail
        isLoading
        navigationTitle="Pair with Track Your Time"
        markdown={[
          `# ${userCode}`,
          "",
          "Approve this code in your browser to finish pairing. The page should",
          "already be open — you need to be signed in to the web app there.",
        ].join("\n")}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.TagList title="Code">
              <Detail.Metadata.TagList.Item text={userCode} color={Color.Blue} />
            </Detail.Metadata.TagList>
            <Detail.Metadata.Label title="Status" text="Waiting for approval…" icon={Icon.Clock} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Link
              title="Approval Page"
              target={approvalUrl}
              text={hostLabel(verificationUri || webLink("/app/device"))}
            />
            <Detail.Metadata.Label title="Server" text={hostLabel(apiUrl())} />
          </Detail.Metadata>
        }
        actions={
          <ActionPanel>
            <Action.OpenInBrowser title="Open Approval Page" url={approvalUrl} />
            <Action.CopyToClipboard title="Copy Code" content={userCode} />
            <Action title="Start over" icon={Icon.Repeat} onAction={retry} />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <Detail
      navigationTitle="Track Your Time"
      markdown={[
        "# Could not pair",
        "",
        phase.message,
        "",
        "---",
        "",
        "Track Your Time did not answer at **API URL**. Check that the address",
        "is right and that the server is running, or open Extension Preferences",
        "and clear **API URL** and **Web App URL** to use the default server.",
        "",
        usesLocalDefaults()
          ? `In this development build the default server is \`${DEFAULT_ORIGINS.development.apiUrl}\`.`
          : `The default server is the hosted service, \`${DEFAULT_ORIGINS.production.apiUrl}\`.`,
      ].join("\n")}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item text="Unreachable" color={Color.Red} />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="API URL" text={hostLabel(apiUrl())} icon={Icon.Globe} />
          <Detail.Metadata.Label title="Web App URL" text={hostLabel(webUrl())} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          <Action title="Try Again" icon={Icon.Repeat} onAction={retry} />
          <Action.OpenInBrowser title="Open Web App" url={webLink("/app/track")} />
        </ActionPanel>
      }
    />
  );
}
