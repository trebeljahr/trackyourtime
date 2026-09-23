"use client";

import * as React from "react";

import { isElectron, isTokenShell } from "@/lib/shell";
import { POST_AUTH_REDIRECT, signIn, webCallbackUrl } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { useT } from "@/i18n/use-t";

/**
 * Why the Google button is or is not live.
 *
 * - `pending`: not mounted yet, or the server has not answered. The button is
 *   disabled, which is also exactly what the prerendered HTML shows.
 * - `unconfigured`: this server has no Google client id and secret.
 * - `shell`: a native or desktop shell. The OAuth redirect returns to the
 *   web origin, and `capacitor://localhost` or the Electron window (`app://-`) can
 *   never be that origin, so a sign-in started here could not come back.
 * - `enabled`: the web app, on a server with Google configured.
 */
export type GoogleAvailability = "pending" | "unconfigured" | "shell" | "enabled";

export function googleAvailability(input: {
  mounted: boolean;
  shell: boolean;
  googleEnabled: boolean | undefined;
}): GoogleAvailability {
  if (!input.mounted) return "pending";
  if (input.shell) return "shell";
  if (input.googleEnabled === undefined) return "pending";
  return input.googleEnabled ? "enabled" : "unconfigured";
}

const NOTES = {
  shell: "auth.google.shellNote",
  desktop: "auth.google.desktopNote",
  unconfigured: "auth.google.unconfiguredNote",
} as const;

/**
 * "Continue with Google", on /login and /signup.
 *
 * Rendered in every build and every host, and decided only after mount:
 * under `output: "export"` the page is prerendered in Node, where neither
 * `window.Capacitor` nor the server's configuration exists, so a tree that
 * branched on either would disagree with the served HTML at hydration.
 */
export function GoogleSignInButton(): React.JSX.Element {
  const [mounted, setMounted] = React.useState(false);
  const [shell, setShell] = React.useState(false);
  const [desktop, setDesktop] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const t = useT("shell");

  React.useEffect(() => {
    // Decided after mount, never during render — the whole point of this
    // component, per the note above: the prerender knows neither
    // `window.Capacitor` nor the server's configuration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShell(isTokenShell());
    setDesktop(isElectron());
    setMounted(true);
  }, []);

  const health = trpc.health.check.useQuery(undefined, {
    enabled: mounted && !shell,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const availability = googleAvailability({
    mounted,
    shell,
    googleEnabled: health.data?.authConfig.googleEnabled,
  });
  const noteKey =
    availability === "shell"
      ? NOTES[desktop ? "desktop" : "shell"]
      : availability === "unconfigured"
        ? NOTES.unconfigured
        : null;
  const note = noteKey ? t(noteKey) : null;

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const result = await signIn.social({
        provider: "google",
        callbackURL: webCallbackUrl(POST_AUTH_REDIRECT),
        errorCallbackURL: webCallbackUrl("/login"),
      });
      if (result.error) {
        setError(result.error.message ?? t("auth.google.couldNotStart"));
        setStarting(false);
      }
      // On success the browser is already navigating to Google.
    } catch {
      setError(t("auth.google.couldNotStart"));
      setStarting(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="google-sign-in" data-availability={availability}>
      <button
        type="button"
        onClick={() => void start()}
        disabled={availability !== "enabled" || starting}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="google-sign-in-button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
          <path
            fill="currentColor"
            d="M21.35 11.1H12v2.9h5.35c-.25 1.45-1.7 4.25-5.35 4.25-3.2 0-5.8-2.65-5.8-5.9s2.6-5.9 5.8-5.9c1.8 0 3.05.8 3.75 1.45l2.55-2.45C16.7 3.95 14.55 3 12 3 6.95 3 2.9 7.05 2.9 12s4.05 9 9.1 9c5.25 0 8.7-3.7 8.7-8.9 0-.6-.05-1.05-.15-1.5z"
          />
        </svg>
        {t("auth.google.continue")}
      </button>
      {note ? (
        <p className="text-center text-xs text-muted-foreground" data-testid="google-sign-in-note">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="text-center text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
